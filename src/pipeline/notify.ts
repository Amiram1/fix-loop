import type { Octokit } from "@octokit/rest";
import type { IssueRef } from "../adapters/github.js";
import { postDiagnosis, renderDiagnosis } from "../notify/diagnosis.js";
import { postNeedsInfo, renderNeedsInfo } from "../notify/needsInfo.js";
import type { Stage } from "./run.js";

export interface NotifyDeps {
	octokit?: Octokit;
	ref?: IssueRef;
	dryRun: boolean;
}

/**
 * Stage 8: tells the reporter what happened when there is no PR. A bug that was not reproduced gets
 * the needs-info question. A reproduced bug with a diagnosis-only gate gets the diagnosis.
 * In a dry run the text is recorded on `ctx.artifacts.delivery` and nothing is posted.
 */
export function makeNotifyStage(deps: NotifyDeps): Stage {
	const target =
		!deps.dryRun && deps.octokit && deps.ref
			? { octokit: deps.octokit, ref: deps.ref }
			: undefined;

	return {
		name: "Notify",
		run: async (ctx) => {
			const repro = ctx.artifacts.reproduction;

			if (repro?.status === "not_reproduced") {
				const input = {
					reason: repro.reason ?? "",
					title: ctx.issue.title,
				};

				if (!target) {
					ctx.artifacts.delivery = {
						status: "dry_run",
						detail: renderNeedsInfo(input),
					};
					return {
						state: "done",
						detail: "dry run: needs-info question not posted",
					};
				}

				ctx.artifacts.delivery = await postNeedsInfo(
					target.octokit,
					target.ref,
					input,
				);
				return { state: "done", detail: "needs-info question posted" };
			}

			const gate = ctx.artifacts.gate;

			if (
				repro?.status === "reproduced" &&
				gate?.delivery === "diagnosis_only"
			) {
				const input = {
					reproduction: repro,
					fix: ctx.artifacts.fix,
					gate,
				};

				if (!target) {
					ctx.artifacts.delivery = {
						status: "dry_run",
						detail: renderDiagnosis(input),
					};
					return {
						state: "done",
						detail: "dry run: diagnosis not posted",
					};
				}

				ctx.artifacts.delivery = await postDiagnosis(
					target.octokit,
					target.ref,
					input,
				);
				return { state: "done", detail: "diagnosis posted" };
			}

			return {
				state: "skipped",
				detail: "nothing to report: a pull request carries the outcome",
			};
		},
	};
}
