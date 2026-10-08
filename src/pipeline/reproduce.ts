import type { BudgetTracker } from "../agent/budget.js";
import type { MessagesApi } from "../agent/client.js";
import { reproduce } from "../repro/loop.js";
import type { AreaRunner, RunContext } from "../repro/runner.js";
import {
	createScratchCheckout,
	removeScratchCheckout,
} from "../repro/workspace.js";
import type { Stage } from "./run.js";

export interface ReproduceDeps {
	client: MessagesApi;
	budget: BudgetTracker;
	/** Checkout of the repo being fixed. The test is written to a scratch worktree, never here. */
	root: string;
	headSha: string;
	runners: Partial<Record<"backend" | "frontend", AreaRunner>>;
	maxTurns?: number;
}

/**
 * Stage 4: writes a test that fails for the reported bug. A bug that cannot be reproduced halts
 * the run, so Fix never starts without a red test to fix against.
 */
export function makeReproduceStage(deps: ReproduceDeps): Stage {
	return {
		name: "Reproduce",
		run: async (ctx) => {
			const area = ctx.artifacts.intake?.area;

			const runner =
				area === "backend" || area === "frontend"
					? deps.runners[area]
					: undefined;

			if (!runner) {
				return {
					state: "halt",
					detail: `no reproduction runner for area "${area ?? "unknown"}"`,
				};
			}

			const checkout = await createScratchCheckout(
				deps.root,
				deps.headSha,
			);

			try {
				const context: RunContext = {
					checkout,
					env: ctx.artifacts.app
						? { FIXLOOP_BASE_URL: ctx.artifacts.app.baseUrl }
						: {},
				};

				if (runner.prepare) await runner.prepare(context);

				const reproduction = await reproduce({
					client: deps.client,
					model: ctx.config.models.fix,
					budget: deps.budget,
					runner,
					context,
					issue: ctx.issue,
					maxTurns: deps.maxTurns ?? 20,
					effort: ctx.config.effort.reproduce,
				});

				ctx.artifacts.reproduction = reproduction;

				if (reproduction.status === "reproduced") {
					return {
						state: "done",
						detail: `${reproduction.testPath} is red`,
					};
				}

				return {
					state: "halt",
					detail: `not reproduced: ${reproduction.reason}`,
				};
			} finally {
				await removeScratchCheckout(checkout);
			}
		},
	};
}
