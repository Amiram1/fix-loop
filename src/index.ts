// Action entry point: route the triggering event, guard it, then run the pipeline on the issue.
import { readFile } from "node:fs/promises";
import { Octokit } from "@octokit/rest";
import { resumeFromReplies, stopRun } from "./adapters/comments.js";
import { fetchIssue, listOpenIssues } from "./adapters/github.js";
import { loadConfig } from "./config/load.js";
import type { FixLoopConfig } from "./config/schema.js";
import { githubDataStore } from "./data/github.js";
import { recordPullRequestOutcome } from "./metrics/outcome.js";
import { notifyAfterRun } from "./notify/slack.js";
import { withBootedApp } from "./pipeline/boot.js";
import { guard } from "./pipeline/guard.js";
import { learnFromRun } from "./pipeline/learn.js";
import { prepareRevise, withEscalation } from "./pipeline/revise.js";
import { type RunContext, runPipeline } from "./pipeline/run.js";
import { stagesFor } from "./pipeline/wiring.js";
import { NEEDS_INFO_LABEL, route } from "./router.js";
import { githubReporter } from "./ui/reporters.js";
import { VERSION } from "./version.js";

export async function main(env = process.env): Promise<void> {
	console.log(`fixloop ${VERSION} on node ${process.version}`);

	const eventPath = env.GITHUB_EVENT_PATH;

	const [owner, repo] = (env.GITHUB_REPOSITORY ?? "").split("/");

	if (!eventPath || !owner || !repo)
		throw new Error("GITHUB_EVENT_PATH and GITHUB_REPOSITORY are required");

	const payload = JSON.parse(await readFile(eventPath, "utf8"));

	const command = route({
		name: env.GITHUB_EVENT_NAME ?? "",
		action: payload.action,
		payload,
	});

	if (command.kind === "ignore") {
		console.log(`fixloop: ignoring event (${command.reason})`);
		return;
	}

	const octokit = new Octokit({ auth: env.GITHUB_TOKEN });

	// A closed FixLoop PR only updates the ledger on the data branch; it does not run the pipeline.
	if (command.kind === "outcome") {
		const changed = await recordPullRequestOutcome(
			githubDataStore(octokit, { owner, repo }),
			command,
		);

		console.log(
			`fixloop: PR #${command.prNumber} ${command.merged ? "merged" : "closed"}; ledger ${changed ? "updated" : "has no row for it"}`,
		);
		return;
	}

	const ref = { owner, repo, issue: command.issue };

	// Stop works whatever the issue's labels say, and starts nothing, so it skips the guard.
	if (command.kind === "stop") {
		console.log(
			await stopRun(octokit, ref, command.actor, env.GITHUB_RUN_ID),
		);
		return;
	}

	const issue = await fetchIssue(octokit, ref);

	const verdict = guard({
		command,
		labels: issue.labels,
		activeRunForIssue: false,
	});

	if (!verdict.allowed) {
		console.log(`fixloop: not starting (${verdict.reason})`);
		return;
	}

	if (command.kind === "hint") {
		issue.replies = [
			...(issue.replies ?? []),
			`Maintainer hint: ${command.text}`,
		];
	}

	// Collected before anything is published: publishing edits the status comment, which is what
	// "after FixLoop last commented" is measured against.
	if (command.kind === "reply") {
		if (!issue.labels.includes(NEEDS_INFO_LABEL)) {
			console.log("fixloop: not resuming (needs-info already cleared)");
			return;
		}

		await resumeFromReplies(octokit, ref, issue);
	}

	const reporter = githubReporter(octokit, ref);

	const runId = env.GITHUB_RUN_ID ?? "local";

	let config: FixLoopConfig;

	try {
		config = await loadConfig();
	} catch (err) {
		// Without config there is nothing to run; say so on the issue instead of failing silently.
		await reporter.publish({
			runId,
			headline: "not started",
			stages: [
				{
					name: "Config",
					state: "failed",
					detail: (err as Error).message,
				},
			],
		});
		process.exitCode = 1;
		return;
	}

	// Only for this run: the config file is not changed.
	if (command.kind === "escalate") config = withEscalation(config);

	const store = githubDataStore(octokit, ref);

	const ctx: RunContext = {
		runId,
		config,
		issue,
		dryRun: false,
		artifacts: {},
	};

	// A review-feedback pass builds on the PR branch and reuses the first run's red test.
	if (command.kind === "revise") {
		const plan = await prepareRevise({
			root: process.cwd(),
			store,
			headRef: command.headRef,
			issue: command.issue,
		});

		if (!plan.ok) {
			await octokit.issues.createComment({
				owner,
				repo,
				issue_number: command.prNumber,
				body: plan.message,
			});
			console.log(`fixloop: not revising (${plan.message})`);
			return;
		}

		ctx.artifacts.reproduction = plan.reproduction;
		ctx.artifacts.revise = { reviewText: command.text };
	}

	// The Action passes the key as an env var or as its `anthropic-api-key` input.
	const apiKey = env.ANTHROPIC_API_KEY ?? env["INPUT_ANTHROPIC-API-KEY"];

	const { stages, budget } = await stagesFor({
		root: process.cwd(),
		config,
		apiKey,
		dataStore: store,
		listOpenIssues: () => listOpenIssues(octokit, ref, 50),
		octokit,
		ref,
		dryRun: false,
		headSha: command.kind === "revise" ? command.headSha : undefined,
	});

	const result = await withBootedApp(ctx, () =>
		runPipeline(ctx, stages, reporter),
	);

	for (const problem of await learnFromRun({
		ctx,
		runId,
		stageMs: result.stageMs,
		spentUsd: budget.spentUsd,
		store,
	})) {
		console.log(`fixloop: ${problem}`);
	}

	// Optional: the Action passes the webhook as its `slack-webhook` input; SLACK_WEBHOOK is for local use.
	for (const line of await notifyAfterRun({
		ctx,
		config,
		webhookUrl: env["INPUT_SLACK-WEBHOOK"] || env.SLACK_WEBHOOK,
		links: {
			issue: `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${owner}/${repo}/issues/${command.issue}`,
		},
		spentUsd: budget.spentUsd,
	})) {
		console.log(`fixloop: ${line}`);
	}

	console.log(
		`fixloop: stage time ${Object.entries(result.stageMs)
			.map(([name, ms]) => `${name} ${Math.round(ms / 1000)}s`)
			.join(", ")}`,
	);
	console.log(`fixloop: model spend this run $${budget.spentUsd.toFixed(4)}`);

	if (!result.ok) process.exitCode = 1;
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
