import type { Octokit } from "@octokit/rest";
import { briefFingerprint, headSha } from "../adapters/git.js";
import type { IssueRef } from "../adapters/github.js";
import { BudgetTracker } from "../agent/budget.js";
import { createMessagesApi } from "../agent/client.js";
import type { FixLoopConfig } from "../config/schema.js";
import type { DataStore } from "../memory/datastore.js";
import { localBriefStore } from "../memory/store.js";
import { defaultRunners } from "../repro/runners.js";
import type { OpenIssue } from "./intake.js";
import type { Stage } from "./run.js";
import { buildStages } from "./stages.js";

export interface WiringOptions {
	/** Checkout of the repo being fixed. */
	root: string;
	config: FixLoopConfig;
	apiKey: string | undefined;
	listOpenIssues?: () => Promise<OpenIssue[]>;
	/** GitHub access for Deliver and Notify. */
	octokit?: Octokit;
	ref?: IssueRef;
	dryRun: boolean;
	/** Where journal entries and the ledger are kept between runs. */
	dataStore?: DataStore;
}

export interface RunWiring {
	stages: Stage[];
	/** The run's spend tracker. Read it after the run to report what it cost. */
	budget: BudgetTracker;
}

/** Builds the pipeline for one run: a fresh budget, the local brief store, and the commit under `root`. */
export async function stagesFor(opts: WiringOptions): Promise<RunWiring> {
	if (!opts.apiKey) {
		throw new Error(
			"ANTHROPIC_API_KEY is not set (add it to .env, the environment, or the Action's secrets)",
		);
	}

	const budget = new BudgetTracker(opts.config.budget.per_run_usd);

	const stages = buildStages({
		client: createMessagesApi(opts.apiKey),
		budget,
		store: localBriefStore(opts.root),
		root: opts.root,
		headSha: await headSha(opts.root),
		briefFingerprint: await briefFingerprint(opts.root),
		listOpenIssues: opts.listOpenIssues,
		runners: defaultRunners(opts.config),
		octokit: opts.octokit,
		ref: opts.ref,
		dryRun: opts.dryRun,
		dataStore: opts.dataStore,
	});

	return { stages, budget };
}
