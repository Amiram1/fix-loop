import type { BudgetTracker } from "../agent/budget.js";
import type { MessagesApi } from "../agent/client.js";
import type { BriefStore } from "../memory/store.js";
import { makeBootStage } from "./boot.js";
import { makeContextStage } from "./context.js";
import { makeIntakeStage, type OpenIssue } from "./intake.js";
import type { Stage } from "./run.js";

export interface StageDeps {
	client: MessagesApi;
	budget: BudgetTracker;
	store: BriefStore;
	/** Checkout of the repo being fixed. Context reads it and Boot starts the app from it. */
	root: string;
	headSha: string;
	listOpenIssues?: () => Promise<OpenIssue[]>;
}

/** Stages that are not implemented yet. They report as skipped so a run shows what is missing. */
export const PENDING_STAGES: Stage[] = ["Reproduce", "Fix", "Deliver"].map(
	(name) => ({
		name,
		run: async () => ({ state: "skipped", detail: "not implemented yet" }),
	}),
);

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
			headSha: deps.headSha,
		}),
		makeBootStage({ cwd: deps.root }),
		...PENDING_STAGES,
	];
}
