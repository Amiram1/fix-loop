import type { BudgetTracker } from "../agent/budget.js";
import type { MessagesApi } from "../agent/client.js";
import { briefKey, generateBrief, topLevelDirs } from "../memory/brief.js";
import type { BriefStore } from "../memory/store.js";
import type { Stage } from "./run.js";

export interface ContextDeps {
	client: MessagesApi;
	budget: BudgetTracker;
	store: BriefStore;
	/** Checkout of the repository being fixed. */
	root: string;
	/** From briefFingerprint: decides when a cached brief is stale. */
	fingerprint: string;
	/** Defaults to `config.models.fix`. */
	model?: string;
	/** Turn limit for generating a brief. Defaults to 25. */
	maxTurns?: number;
}

const DEFAULT_BRIEF_TURNS = 25;

/** Gets the codebase brief from the store, or generates and stores it, and hands it to later stages. */
export function makeContextStage(deps: ContextDeps): Stage {
	return {
		name: "Context",
		run: async (ctx) => {
			const key = briefKey(
				deps.fingerprint,
				await topLevelDirs(deps.root),
			);

			const cached = await deps.store.get(key);

			if (cached) {
				ctx.artifacts.brief = cached;

				return { state: "done", detail: "cached" };
			}

			const { text } = await generateBrief({
				root: deps.root,
				client: deps.client,
				model: deps.model ?? ctx.config.models.fix,
				budget: deps.budget,
				maxTurns: deps.maxTurns ?? DEFAULT_BRIEF_TURNS,
			});

			await deps.store.put(key, text);
			ctx.artifacts.brief = text;

			return { state: "done", detail: "generated" };
		},
	};
}
