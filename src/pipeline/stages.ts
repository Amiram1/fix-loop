import type { BudgetTracker } from "../agent/budget.js";
import type { MessagesApi } from "../agent/client.js";
import type { BriefStore } from "../memory/store.js";
import type { AreaRunner } from "../repro/runner.js";
import { makeBootStage } from "./boot.js";
import { makeContextStage } from "./context.js";
import { makeIntakeStage, type OpenIssue } from "./intake.js";
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
}

/** Stages that are not implemented yet. They report as skipped so a run shows what is missing. */
export const PENDING_STAGES: Stage[] = ["Fix", "Deliver"].map((name) => ({
	name,
	run: async () => ({ state: "skipped", detail: "not implemented yet" }),
}));

/** The full pipeline in order: Intake, Context, Boot, Reproduce, then the pending Fix and Deliver. */
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
		}),
		...PENDING_STAGES,
	];
}
