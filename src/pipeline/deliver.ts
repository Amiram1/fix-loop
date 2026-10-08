import type { Octokit } from "@octokit/rest";
import type { IssueRef } from "../adapters/github.js";
import { deliverFix } from "../deliver/deliver.js";
import type { Stage } from "./run.js";

export interface DeliverDeps {
	/** Checkout of the repo being fixed. */
	root: string;
	headSha: string;
	/** Absent when there is no GitHub access. Without it, or with dryRun, nothing is written. */
	octokit?: Octokit;
	ref?: IssueRef;
	dryRun: boolean;
}

/** Stage 7: opens or updates the PR the gate asked for. Writes `ctx.artifacts.delivery`. */
export function makeDeliverStage(deps: DeliverDeps): Stage {
	return {
		name: "Deliver",
		run: async (ctx) => {
			const gate = ctx.artifacts.gate;

			if (!gate) return { state: "skipped", detail: "no gate result" };

			const result = await deliverFix({
				root: deps.root,
				headSha: deps.headSha,
				ctx,
				gate,
				octokit: deps.octokit,
				ref: deps.ref,
				dryRun: deps.dryRun,
			});

			ctx.artifacts.delivery = result;

			if (result.status === "skipped") {
				return { state: "skipped", detail: result.detail ?? "no PR" };
			}

			return {
				state: "done",
				detail: result.url ?? result.detail ?? result.status,
			};
		},
	};
}
