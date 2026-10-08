import type { Octokit } from "@octokit/rest";
import type { IssueRef } from "../adapters/github.js";
import type { BudgetTracker } from "../agent/budget.js";
import type { MessagesApi } from "../agent/client.js";
import type { DataStore } from "../memory/datastore.js";
import type { BriefStore } from "../memory/store.js";
import type { AreaRunner } from "../repro/runner.js";
import { makeBootStage } from "./boot.js";
import { makeContextStage } from "./context.js";
import { makeDeliverStage } from "./deliver.js";
import { makeFixStage } from "./fix.js";
import { makeGateStage } from "./gate.js";
import { makeIntakeStage, type OpenIssue } from "./intake.js";
import { makeNotifyStage } from "./notify.js";
import { makeReproduceStage } from "./reproduce.js";
import type { Stage } from "./run.js";

export interface StageDeps {
	client: MessagesApi;
	budget: BudgetTracker;
	store: BriefStore;
	/** Checkout of the repo being fixed. Context reads it and Boot starts the app from it. */
	root: string;
	headSha: string;
	/** Brief cache key input. See briefFingerprint. */
	briefFingerprint: string;
	listOpenIssues?: () => Promise<OpenIssue[]>;
	runners: Partial<Record<"backend" | "frontend", AreaRunner>>;
	/** GitHub access for Deliver and Notify. Without it, or with dryRun, nothing is written to GitHub. */
	octokit?: Octokit;
	ref?: IssueRef;
	dryRun: boolean;
	/** Journal entries from earlier runs are read from here. */
	dataStore?: DataStore;
}

/** The full pipeline in order. Boot runs after Context and before Reproduce. */
export function buildStages(deps: StageDeps): Stage[] {
	return [
		makeIntakeStage({
			client: deps.client,
			budget: deps.budget,
			listOpenIssues: deps.listOpenIssues,
		}),
		makeContextStage({
			client: deps.client,
			budget: deps.budget,
			store: deps.store,
			root: deps.root,
			fingerprint: deps.briefFingerprint,
		}),
		makeBootStage({ cwd: deps.root }),
		makeReproduceStage({
			client: deps.client,
			budget: deps.budget,
			root: deps.root,
			headSha: deps.headSha,
			runners: deps.runners,
			store: deps.dataStore,
		}),
		makeFixStage({
			client: deps.client,
			budget: deps.budget,
			root: deps.root,
			headSha: deps.headSha,
			runners: deps.runners,
			store: deps.dataStore,
		}),
		makeGateStage(),
		makeDeliverStage({
			root: deps.root,
			headSha: deps.headSha,
			octokit: deps.octokit,
			ref: deps.ref,
			dryRun: deps.dryRun,
		}),
		makeNotifyStage({
			octokit: deps.octokit,
			ref: deps.ref,
			dryRun: deps.dryRun,
		}),
	];
}
