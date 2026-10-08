import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.js";
import { localDataStore } from "../src/memory/datastore.js";
import {
	appendRecord,
	LEDGER_PATH,
	type RunRecord,
	readRecords,
	recordFrom,
	summarize,
} from "../src/metrics/ledger.js";
import type { RunContext, StageRecord } from "../src/pipeline/run.js";

const config = parseConfig(
	"app:\n  up: x\n  base_url: http://localhost:3456\ntests:\n  full: 'true'\n",
);

const ctxWith = (artifacts: RunContext["artifacts"]): RunContext => ({
	runId: "t",
	config,
	issue: { number: 3, title: "Tasks vanish", body: "they disappear" },
	dryRun: false,
	artifacts,
});

const result = (
	stages: StageRecord[] = [],
	stageMs: Record<string, number> = {},
) => ({ stages, stageMs });

const row = (over: Partial<RunRecord> = {}): RunRecord => ({
	runId: "r1",
	issue: 1,
	createdAt: "2026-10-01T00:00:00.000Z",
	reproduced: true,
	fixAttempts: 1,
	models: ["haiku"],
	costUsd: 0.1,
	stageMs: {},
	totalMs: 60_000,
	humanTouches: 0,
	outcome: "open",
	...over,
});

describe("recordFrom", () => {
	it("reads the artifacts of a run that opened a PR", () => {
		const rec = recordFrom(
			ctxWith({
				intake: {
					area: "backend",
					severity: "S2",
					summary: "s",
					injectionSuspected: false,
				},
				reproduction: {
					status: "reproduced",
					area: "backend",
					attempts: 2,
					costUsd: 0.25,
				},
				fix: {
					status: "fixed",
					diff: "",
					filesChanged: [],
					models: ["haiku", "opus"],
					attempts: 3,
					costUsd: 0.5,
				},
				gate: {
					delivery: "draft_pr",
					confidence: 0.6,
					risky: false,
					reasons: [],
				},
				delivery: {
					status: "pr_opened",
					url: "https://github.com/o/r/pull/42",
					branch: "fixloop/issue-3",
				},
			}),
			"run-9",
			result(
				[
					{ name: "Intake", state: "done" },
					{ name: "Fix", state: "done" },
				],
				{ Intake: 1000, Fix: 2000 },
			),
		);

		expect(rec).toMatchObject({
			runId: "run-9",
			issue: 3,
			area: "backend",
			severity: "S2",
			delivery: "draft_pr",
			reproduced: true,
			fixAttempts: 3,
			models: ["haiku", "opus"],
			costUsd: 0.75,
			stageMs: { Intake: 1000, Fix: 2000 },
			totalMs: 3000,
			stages: [
				{ name: "Intake", state: "done" },
				{ name: "Fix", state: "done" },
			],
			status: "completed",
			humanTouches: null,
			prNumber: 42,
			branch: "fixloop/issue-3",
			outcome: "open",
		});
		expect(rec.failedStage).toBeUndefined();
		expect(Number.isNaN(Date.parse(rec.createdAt))).toBe(false);
		// Learn runs right after Deliver, so the PR was opened when the row was made.
		expect(rec.prOpenedAt).toBe(rec.createdAt);
	});

	it("carries the issue's creation time and the human-touch count it is given", () => {
		const ctx = ctxWith({});

		ctx.issue.issueCreatedAt = "2026-10-01T09:00:00.000Z";

		expect(recordFrom(ctx, "r", result(), undefined, 3)).toMatchObject({
			issueCreatedAt: "2026-10-01T09:00:00.000Z",
			humanTouches: 3,
		});
		expect(recordFrom(ctx, "r", result(), undefined, 0).humanTouches).toBe(
			0,
		);
		// Not counted is null, never 0.
		expect(recordFrom(ctx, "r", result()).humanTouches).toBeNull();
	});

	it("says how the run ended, by stage", () => {
		const done: StageRecord = { name: "A", state: "done" };

		const pending: StageRecord = { name: "C", state: "pending" };

		expect(recordFrom(ctxWith({}), "r", result([done])).status).toBe(
			"completed",
		);

		const halted = recordFrom(
			ctxWith({}),
			"r",
			result([
				done,
				{ name: "B", state: "halted", detail: "not reproduced" },
				{ name: "C", state: "skipped", detail: "not run" },
			]),
		);

		expect(halted.status).toBe("halted");
		expect(halted.failedStage).toBeUndefined();

		const failed = recordFrom(
			ctxWith({}),
			"r",
			result([
				done,
				{ name: "B", state: "failed", detail: "boom" },
				pending,
			]),
		);

		expect(failed).toMatchObject({ status: "failed", failedStage: "B" });
		expect(failed.stages).toHaveLength(3);

		// Stopped wins over what the stages show: it is why they ended.
		const ctx = ctxWith({});

		(ctx.artifacts as { stopped?: unknown }).stopped = { reason: "budget" };

		expect(
			recordFrom(ctx, "r", result([{ name: "B", state: "halted" }]))
				.status,
		).toBe("stopped");
	});

	it("does not throw when artifacts are missing", () => {
		const rec = recordFrom(ctxWith({}), "run-1", result());

		expect(rec).toMatchObject({
			issue: 3,
			reproduced: false,
			fixAttempts: 0,
			models: [],
			costUsd: 0,
			totalMs: 0,
			outcome: "open",
		});
		expect(rec.prNumber).toBeUndefined();
		expect(rec.branch).toBeUndefined();
		expect(rec.prOpenedAt).toBeUndefined();
	});

	it("has no PR for a dry run, and takes the budget's cost when given", () => {
		const rec = recordFrom(
			ctxWith({
				delivery: {
					status: "dry_run",
					branch: "fixloop/issue-3",
					url: "https://github.com/o/r/pull/42",
				},
			}),
			"run-1",
			result(),
			1.5,
		);

		expect(rec.prNumber).toBeUndefined();
		expect(rec.branch).toBeUndefined();
		expect(rec.prOpenedAt).toBeUndefined();
		expect(rec.costUsd).toBe(1.5);
	});
});

describe("ledger file", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "fixloop-ledger-"));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("round-trips appended records, one line each", async () => {
		const store = localDataStore(root);

		expect(await readRecords(store)).toEqual([]);

		await appendRecord(store, row({ runId: "a" }));
		await appendRecord(store, row({ runId: "b", prNumber: 5 }));

		expect(await readRecords(store)).toEqual([
			row({ runId: "a" }),
			row({ runId: "b", prNumber: 5 }),
		]);
		expect(
			(await store.read(LEDGER_PATH))?.trimEnd().split("\n"),
		).toHaveLength(2);
	});

	it("skips lines that are not valid records", async () => {
		const store = localDataStore(root);

		await store.write(
			LEDGER_PATH,
			[
				JSON.stringify(row({ runId: "a" })),
				"{not json",
				JSON.stringify({ runId: "x" }),
				JSON.stringify(
					row({ runId: "bad", outcome: "weird" as never }),
				),
				"",
				JSON.stringify(row({ runId: "b" })),
			].join("\n"),
		);

		expect((await readRecords(store)).map((r) => r.runId)).toEqual([
			"a",
			"b",
		]);

		// A file with no trailing newline still gets its new row on its own line.
		await appendRecord(store, row({ runId: "c" }));

		expect((await readRecords(store)).map((r) => r.runId)).toEqual([
			"a",
			"b",
			"c",
		]);
	});
});

describe("summarize", () => {
	// A run that opened its PR `minutes` after the issue was opened.
	const prAfter = (minutes: number, over: Partial<RunRecord> = {}) =>
		row({
			prNumber: 1,
			issueCreatedAt: "2026-10-01T09:00:00.000Z",
			prOpenedAt: new Date(
				Date.parse("2026-10-01T09:00:00.000Z") + minutes * 60_000,
			).toISOString(),
			...over,
		});

	it("is all zeros for no records, with no MTTR and no human share", () => {
		expect(summarize([])).toEqual({
			runs: 0,
			mttrToPrMinutes: undefined,
			medianRunMinutes: undefined,
			reproductionRate: 0,
			prMergeRate: 0,
			meanCostUsd: 0,
			noHumanShare: undefined,
			escalated: 0,
		});
	});

	it("computes the aggregates", () => {
		const s = summarize([
			row({
				prNumber: 1,
				totalMs: 60_000,
				outcome: "merged",
				costUsd: 0.1,
			}),
			row({
				prNumber: 2,
				totalMs: 180_000,
				outcome: "closed",
				costUsd: 0.3,
			}),
			row({
				prNumber: 3,
				totalMs: 600_000,
				outcome: "merged",
				models: ["haiku", "opus"],
				costUsd: 0.5,
			}),
			row({
				reproduced: false,
				totalMs: 9_000_000,
				outcome: "open",
				costUsd: 0.1,
			}),
		]);

		expect(s.runs).toBe(4);
		// Median run time of 1, 3 and 10 minutes: the run that opened no PR does not count.
		expect(s.medianRunMinutes).toBe(3);
		// These rows have no issue or PR times, so there is no time to PR.
		expect(s.mttrToPrMinutes).toBeUndefined();
		expect(s.reproductionRate).toBe(0.75);
		expect(s.prMergeRate).toBeCloseTo(2 / 3);
		expect(s.meanCostUsd).toBeCloseTo(0.25);
		expect(s.noHumanShare).toBe(1);
		expect(s.escalated).toBe(1);
	});

	it("takes the middle pair of run times for an even number of PRs", () => {
		expect(
			summarize([
				row({ prNumber: 1, totalMs: 60_000 }),
				row({ prNumber: 2, totalMs: 180_000 }),
			]).medianRunMinutes,
		).toBe(2);
	});

	it("measures MTTR as issue opened to PR opened, not run duration", () => {
		const s = summarize([
			// Short runs, long waits: the waiting is what the metric must show.
			prAfter(10, { totalMs: 1000 }),
			prAfter(30, { totalMs: 1000 }),
			prAfter(120, { totalMs: 1000 }),
		]);

		expect(s.mttrToPrMinutes).toBe(30);
		expect(s.medianRunMinutes).toBeCloseTo(1000 / 60_000);
		expect(summarize([prAfter(10), prAfter(31)]).mttrToPrMinutes).toBe(
			20.5,
		);
	});

	it("leaves out rows that lack either time, or whose times are wrong", () => {
		const s = summarize([
			prAfter(10),
			prAfter(5, { issueCreatedAt: undefined }),
			prAfter(5, { prOpenedAt: undefined }),
			prAfter(5, { prOpenedAt: "not a date" }),
			prAfter(-5),
			row(),
		]);

		expect(s.mttrToPrMinutes).toBe(10);
		expect(
			summarize([row(), prAfter(5, { prOpenedAt: undefined })])
				.mttrToPrMinutes,
		).toBeUndefined();
	});

	it("reads old rows as they are, without stages, status or times", () => {
		// What the ledger held before these fields: a count of 0 and no stages.
		const old = JSON.parse(JSON.stringify(row())) as RunRecord;

		expect(old.stages).toBeUndefined();
		expect(old.status).toBeUndefined();
		expect(() => summarize([old, prAfter(4)])).not.toThrow();
		expect(summarize([old, prAfter(4)]).mttrToPrMinutes).toBe(4);
	});

	it("leaves open and reverted PRs out of the merge rate", () => {
		expect(
			summarize([row({ outcome: "open" }), row({ outcome: "reverted" })])
				.prMergeRate,
		).toBe(0);
		expect(
			summarize([
				row({ outcome: "merged" }),
				row({ outcome: "reverted" }),
				row({ outcome: "open" }),
			]).prMergeRate,
		).toBe(1);
	});

	it("counts runs where a human touched the work against the share", () => {
		expect(summarize([row(), row({ humanTouches: 2 })]).noHumanShare).toBe(
			0.5,
		);
	});

	it("ignores runs that were not counted in the no-human share", () => {
		expect(
			summarize([
				row({ humanTouches: null }),
				row({ humanTouches: null }),
				row({ humanTouches: 0 }),
				row({ humanTouches: 1 }),
			]).noHumanShare,
		).toBe(0.5);
		expect(
			summarize([row({ humanTouches: null })]).noHumanShare,
		).toBeUndefined();
	});
});
