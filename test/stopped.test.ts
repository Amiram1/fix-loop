import { describe, expect, it, vi } from "vitest";
import { BudgetExceeded, BudgetTracker } from "../src/agent/budget.js";
import { parseConfig } from "../src/config/load.js";
import {
	postStopped,
	renderStopped,
	STOPPED_MARKER,
} from "../src/notify/stopped.js";
import { makeDeliverStage } from "../src/pipeline/deliver.js";
import { makeGateStage } from "../src/pipeline/gate.js";
import { makeNotifyStage } from "../src/pipeline/notify.js";
import {
	type RunContext,
	runPipeline,
	type Stage,
} from "../src/pipeline/run.js";
import type { StatusView } from "../src/ui/statusComment.js";
import { fakeOctokit, REPO } from "./fakeOctokit.js";

const config = parseConfig(
	"app:\n  up: x\n  base_url: http://localhost:3456\ntests:\n  full: 'true'\n",
);

const ctxWith = (dryRun: boolean): RunContext => ({
	runId: "t",
	config,
	issue: { number: 7, title: "Tasks vanish", body: "", labels: [] },
	dryRun,
	artifacts: {},
});

const reporter = () => {
	const views: StatusView[] = [];

	return {
		views,
		reporter: {
			publish: async (v: StatusView) =>
				void views.push(structuredClone(v)),
		},
	};
};

/** Throws what the budget tracker throws once the limit is reached. */
const outOfBudget = (name: string): Stage => ({
	name,
	run: async () => {
		const budget = new BudgetTracker(1.5);

		budget.record(1.5123);
		budget.assertCanSpend();

		return { state: "done" };
	},
});

describe("renderStopped", () => {
	it("says the budget, the spend, that nothing was pushed, and how to retry", () => {
		expect(
			renderStopped({
				reason: "budget",
				spentUsd: 1.5123,
				limitUsd: 1.5,
			}),
		).toBe(
			`${STOPPED_MARKER}\nFixLoop stopped: the run budget ($1.50) was reached after $1.51. Nothing was pushed. A maintainer can run \`/fixloop retry\` to try again.`,
		);
	});
});

describe("postStopped", () => {
	const info = { reason: "budget" as const, spentUsd: 2, limitUsd: 2 };

	it("posts its own marked comment and edits it in place on a repeat", async () => {
		const { octokit, state } = fakeOctokit();

		const result = await postStopped(octokit, REPO, info);

		expect(result.status).toBe("stopped_posted");
		expect(state.comments).toHaveLength(1);
		expect(state.comments[0]?.body).toContain(STOPPED_MARKER);

		await postStopped(octokit, REPO, info);

		expect(state.comments).toHaveLength(1);
	});
});

describe("a run that runs out of budget", () => {
	it("records the stop, skips the stage, and still runs the later stages", async () => {
		const ctx = ctxWith(true);

		const { views, reporter: r } = reporter();

		const later = vi.fn(async () => ({ state: "done" as const }));

		const result = await runPipeline(
			ctx,
			[outOfBudget("Fix"), { name: "Gate", run: later }],
			r,
		);

		expect(result.ok).toBe(true);
		expect(later).toHaveBeenCalled();
		expect(ctx.artifacts.stopped).toEqual({
			reason: "budget",
			spentUsd: 1.5123,
			limitUsd: 1.5,
		});
		expect(views.at(-1)?.headline).toBe("finished");
		expect(views.at(-1)?.stages[0]).toMatchObject({
			name: "Fix",
			state: "skipped",
			detail: "run budget reached",
		});
	});

	it("treats every later stage that hits the budget the same way, keeping the first numbers", async () => {
		const ctx = ctxWith(true);

		const second: Stage = {
			name: "B",
			run: async () => {
				throw new BudgetExceeded("again", 9, 9);
			},
		};

		const result = await runPipeline(
			ctx,
			[outOfBudget("A"), second],
			reporter().reporter,
		);

		expect(result.ok).toBe(true);
		expect(ctx.artifacts.stopped?.spentUsd).toBe(1.5123);
	});

	it("runs Gate, Deliver and Notify after Fix runs out, and Notify records the stopped comment in a dry run", async () => {
		const ctx = ctxWith(true);

		const result = await runPipeline(
			ctx,
			[
				outOfBudget("Fix"),
				makeGateStage(),
				makeDeliverStage({
					root: "/tmp",
					headSha: "abc",
					dryRun: true,
				}),
				makeNotifyStage({ dryRun: true }),
			],
			reporter().reporter,
		);

		expect(result.ok).toBe(true);
		expect(ctx.artifacts.gate?.delivery).toBe("diagnosis_only");
		expect(ctx.artifacts.delivery?.status).toBe("dry_run");
		expect(ctx.artifacts.delivery?.detail).toContain("FixLoop stopped");
		expect(ctx.artifacts.delivery?.detail).not.toContain("needs more");
	});

	it("posts the stopped comment when not a dry run", async () => {
		const ctx = ctxWith(false);

		const { octokit, state } = fakeOctokit();

		const result = await runPipeline(
			ctx,
			[
				outOfBudget("Fix"),
				makeGateStage(),
				makeNotifyStage({ octokit, ref: REPO, dryRun: false }),
			],
			reporter().reporter,
		);

		expect(result.ok).toBe(true);
		expect(ctx.artifacts.delivery?.status).toBe("stopped_posted");
		expect(state.comments).toHaveLength(1);
		expect(state.comments[0]?.body).toContain(
			"the run budget ($1.50) was reached after $1.51",
		);
	});

	it("still fails the run for any other error", async () => {
		const ctx = ctxWith(true);

		const boom: Stage = {
			name: "Fix",
			run: async () => {
				throw new Error("kaboom");
			},
		};

		const later = vi.fn(async () => ({ state: "done" as const }));

		const result = await runPipeline(
			ctx,
			[boom, { name: "Gate", run: later }],
			reporter().reporter,
		);

		expect(result).toMatchObject({ ok: false, failedStage: "Fix" });
		expect(later).not.toHaveBeenCalled();
		expect(ctx.artifacts.stopped).toBeUndefined();
	});
});
