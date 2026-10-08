import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { Octokit } from "@octokit/rest";
import { fetchIssue, listOpenIssues } from "../adapters/github.js";
import { stopAllBooted } from "../boot/registry.js";
import { withDevModels } from "../config/dev.js";
import { loadConfig } from "../config/load.js";
import { localDataStore } from "../memory/datastore.js";
import { withBootedApp } from "../pipeline/boot.js";
import { guard } from "../pipeline/guard.js";
import { learnFromRun } from "../pipeline/learn.js";
import { type RunContext, runPipeline } from "../pipeline/run.js";
import { stagesFor } from "../pipeline/wiring.js";
import { removeAllScratchCheckouts } from "../repro/workspace.js";
import { consoleReporter, githubReporter } from "../ui/reporters.js";

const execFileP = promisify(execFile);

/** How many open issues Intake sees when it looks for duplicates. */
const OPEN_ISSUE_LIMIT = 50;

export class UsageError extends Error {
	override name = "UsageError";
}

export interface RunOptions {
	issue: number;
	repo?: string;
	config: string;
	dev: boolean;
	dryRun: boolean;
	stage?: string;
}

const FLAGS = {
	issue: { type: "string" },
	repo: { type: "string" },
	config: { type: "string" },
	dev: { type: "boolean" },
	"dry-run": { type: "boolean" },
	stage: { type: "string" },
} as const;

function parseFlags(argv: string[]) {
	try {
		return parseArgs({ args: argv, options: FLAGS, strict: true }).values;
	} catch (err) {
		throw new UsageError((err as Error).message);
	}
}

export function parseRunArgs(argv: string[]): RunOptions {
	const values = parseFlags(argv);

	const issue = Number(values.issue);

	if (!values.issue || !Number.isInteger(issue) || issue <= 0) {
		throw new UsageError("--issue must be a positive integer");
	}

	if (values.repo && !/^[^/\s]+\/[^/\s]+$/.test(values.repo)) {
		throw new UsageError("--repo must be owner/name");
	}

	return {
		issue,
		repo: values.repo,
		config: values.config ?? ".fixloop.yml",
		dev: values.dev ?? false,
		dryRun: values["dry-run"] ?? false,
		stage: values.stage,
	};
}

/** Extracts owner/name from a GitHub remote URL (https or ssh). */
export function parseRepoSlug(remoteUrl: string): string | undefined {
	const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(
		remoteUrl.trim(),
	);

	return match ? `${match[1]}/${match[2]}` : undefined;
}

export async function resolveRepo(explicit?: string): Promise<string> {
	if (explicit) return explicit;

	if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;

	const { stdout } = await execFileP("git", ["remote", "get-url", "origin"]);

	const slug = parseRepoSlug(stdout);

	if (!slug)
		throw new UsageError(
			"could not infer the repo from origin; pass --repo owner/name",
		);

	return slug;
}

export async function resolveToken(): Promise<string> {
	if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;

	try {
		const { stdout } = await execFileP("gh", ["auth", "token"]);

		return stdout.trim();
	} catch {
		throw new UsageError(
			"no GitHub token: set GITHUB_TOKEN or run `gh auth login`",
		);
	}
}

/** Runs the pipeline for one issue. Returns the process exit code. */
export async function runCommand(opts: RunOptions): Promise<number> {
	const [owner, repo] = (await resolveRepo(opts.repo)).split("/");

	const octokit = new Octokit({ auth: await resolveToken() });

	const ref = { owner, repo, issue: opts.issue };

	const loaded = await loadConfig(opts.config);

	const config = opts.dev ? withDevModels(loaded) : loaded;

	const issue = await fetchIssue(octokit, ref);

	const verdict = guard({
		command: { kind: "start", issue: issue.number, actor: "cli" },
		labels: issue.labels,
		activeRunForIssue: false,
	});

	if (!verdict.allowed) {
		console.log(`fixloop: not starting (${verdict.reason})`);
		return 0;
	}

	const ctx: RunContext = {
		runId: `local-${Date.now()}`,
		config,
		issue,
		dryRun: opts.dryRun,
		artifacts: {},
	};

	const reporter = opts.dryRun
		? consoleReporter()
		: githubReporter(octokit, ref);

	const root = resolve(dirname(opts.config));

	const store = localDataStore(root);

	const { stages, budget } = await stagesFor({
		root,
		config,
		apiKey: process.env.ANTHROPIC_API_KEY,
		dataStore: store,
		listOpenIssues: () => listOpenIssues(octokit, ref, OPEN_ISSUE_LIMIT),
		octokit,
		ref,
		dryRun: opts.dryRun,
	});

	// Ctrl-C or a kill must not leave the app running. If the signal lands during Boot, the app is
	// not recorded yet, so `down` runs directly; it is safe when nothing is up.
	const onSignal = (signal: NodeJS.Signals) => {
		void stopAllBooted()
			.then(() => removeAllScratchCheckouts())
			.catch(() => undefined)
			.finally(() => {
				process.exit(signal === "SIGINT" ? 130 : 143);
			});
	};

	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);

	let result: Awaited<ReturnType<typeof runPipeline>>;

	try {
		result = await withBootedApp(ctx, () =>
			runPipeline(ctx, stages, reporter, opts.stage),
		);

		// A dry run is for review, so show the change that Fix made.
		if (opts.dryRun && ctx.artifacts.fix?.diff) {
			console.log(
				`\n--- proposed change (${ctx.artifacts.fix.status}) ---\n${ctx.artifacts.fix.diff}`,
			);
		}

		// A dry run shows what Deliver and Notify would have done, in full.
		if (opts.dryRun && ctx.artifacts.delivery) {
			const { status, url, detail } = ctx.artifacts.delivery;

			console.log(
				`\n--- delivery (${status}${url ? `, ${url}` : ""}) ---\n${detail ?? ""}`,
			);
		}

		// The status line keeps only the first line of a rejection, so print the whole reason here.
		if (opts.dryRun && ctx.artifacts.fix?.status === "not_fixed") {
			console.log(
				`\n--- why not fixed ---\n${ctx.artifacts.fix.reason ?? "(no reason)"}`,
			);
		}
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
	}

	for (const problem of await learnFromRun({
		ctx,
		runId: ctx.runId,
		result,
		spentUsd: budget.spentUsd,
		store,
	})) {
		console.log(`fixloop: ${problem}`);
	}

	console.log(`fixloop: model spend this run $${budget.spentUsd.toFixed(4)}`);

	return result.ok ? 0 : 1;
}
