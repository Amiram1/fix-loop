// Action entry point: route the triggering event, guard it, then run the pipeline on the issue.
import { readFile } from "node:fs/promises";
import { Octokit } from "@octokit/rest";
import { resumeFromReplies } from "./adapters/comments.js";
import { fetchIssue, listOpenIssues } from "./adapters/github.js";
import { loadConfig } from "./config/load.js";
import type { FixLoopConfig } from "./config/schema.js";
import { withBootedApp } from "./pipeline/boot.js";
import { guard } from "./pipeline/guard.js";
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

	const ref = { owner, repo, issue: command.issue };

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

	const ctx: RunContext = {
		runId,
		config,
		issue,
		dryRun: false,
		artifacts: {},
	};

	// The Action passes the key as an env var or as its `anthropic-api-key` input.
	const apiKey = env.ANTHROPIC_API_KEY ?? env["INPUT_ANTHROPIC-API-KEY"];

	const { stages, budget } = await stagesFor({
		root: process.cwd(),
		config,
		apiKey,
		listOpenIssues: () => listOpenIssues(octokit, ref, 50),
	});

	const result = await withBootedApp(ctx, () =>
		runPipeline(ctx, stages, reporter),
	);

	console.log(`fixloop: model spend this run $${budget.spentUsd.toFixed(4)}`);

	if (!result.ok) process.exitCode = 1;
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
