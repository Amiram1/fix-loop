import type { FixLoopConfig } from "../config/schema.js";
import type { StageState, StatusView } from "../ui/statusComment.js";
import type { RunArtifacts } from "./artifacts.js";

export interface IssueInfo {
	number: number;
	title: string;
	body: string;
	labels: string[];
	/** Replies from the reporter since FixLoop last commented. Untrusted text, like the body. */
	replies?: string[];
}

export interface RunContext {
	runId: string;
	config: FixLoopConfig;
	issue: IssueInfo;
	dryRun: boolean;
	/** Filled in by earlier stages for later ones. See artifacts.ts for ownership. */
	artifacts: RunArtifacts;
}

export interface StageOutcome {
	/** "halt" stops the run cleanly: later stages are not run and the run is not a failure. */
	state: "done" | "skipped" | "halt";
	detail?: string;
}

export interface Stage {
	name: string;
	run: (ctx: RunContext) => Promise<StageOutcome>;
}

export interface Reporter {
	publish: (view: StatusView) => Promise<void>;
}

export interface RunResult {
	ok: boolean;
	failedStage?: string;
	haltedAt?: string;
	/** Wall-clock time per stage that ran, in milliseconds. Feeds the run ledger. */
	stageMs: Record<string, number>;
}

/**
 * Runs stages in order, publishing the status view after every state change.
 * A throwing stage marks itself failed and stops the run. `onlyStage` runs a single stage
 * and marks the rest as not selected.
 */
export async function runPipeline(
	ctx: RunContext,
	stages: Stage[],
	reporter: Reporter,
	onlyStage?: string,
): Promise<RunResult> {
	if (onlyStage && !stages.some((s) => s.name === onlyStage)) {
		const known = stages.map((s) => s.name).join(", ");

		throw new Error(`unknown stage "${onlyStage}". Known stages: ${known}`);
	}

	const stageMs: Record<string, number> = {};

	const rows: StatusView["stages"] = stages.map((s) => ({
		name: s.name,
		state: "pending" as StageState,
	}));

	const publish = (headline: string) =>
		reporter.publish({ runId: ctx.runId, headline, stages: [...rows] });

	await publish("running");

	for (const [i, stage] of stages.entries()) {
		if (onlyStage && stage.name !== onlyStage) {
			rows[i] = {
				name: stage.name,
				state: "skipped",
				detail: "not selected",
			};
			continue;
		}

		rows[i] = { name: stage.name, state: "running" };
		await publish("running");

		try {
			const started = Date.now();

			const outcome = await stage.run(ctx);

			stageMs[stage.name] = Date.now() - started;

			if (outcome.state === "halt") {
				rows[i] = {
					name: stage.name,
					state: "halted",
					detail: outcome.detail,
				};
				for (let j = i + 1; j < rows.length; j++) {
					rows[j] = {
						name: rows[j]?.name ?? "",
						state: "skipped",
						detail: "not run",
					};
				}
				await publish(`stopped at ${stage.name}`);
				return { ok: true, haltedAt: stage.name, stageMs };
			}

			rows[i] = {
				name: stage.name,
				state: outcome.state,
				detail: outcome.detail,
			};
		} catch (err) {
			rows[i] = {
				name: stage.name,
				state: "failed",
				detail: (err as Error).message,
			};
			await publish(`failed at ${stage.name}`);
			return { ok: false, failedStage: stage.name, stageMs };
		}
		await publish("running");
	}

	await publish("finished");
	return { ok: true, stageMs };
}
