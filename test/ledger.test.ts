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
import type { RunContext } from "../src/pipeline/run.js";

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
			{ Intake: 1000, Fix: 2000 },
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
			humanTouches: 0,
			prNumber: 42,
			branch: "fixloop/issue-3",
			outcome: "open",
		});
		expect(Number.isNaN(Date.parse(rec.createdAt))).toBe(false);
	});

	it("does not throw when artifacts are missing", () => {
		const rec = recordFrom(ctxWith({}), "run-1", {});

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
			{},
			1.5,
		);

		expect(rec.prNumber).toBeUndefined();
		expect(rec.branch).toBeUndefined();
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
	it("is all zeros for no records, with no MTTR", () => {
		expect(summarize([])).toEqual({
			runs: 0,
			mttrToPrMinutes: undefined,
			reproductionRate: 0,
			prMergeRate: 0,
			meanCostUsd: 0,
			noHumanShare: 0,
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
		// Median of 1, 3 and 10 minutes: the run that opened no PR does not count.
		expect(s.mttrToPrMinutes).toBe(3);
		expect(s.reproductionRate).toBe(0.75);
		expect(s.prMergeRate).toBeCloseTo(2 / 3);
		expect(s.meanCostUsd).toBeCloseTo(0.25);
		expect(s.noHumanShare).toBe(1);
		expect(s.escalated).toBe(1);
	});

	it("takes the middle pair for an even number of PRs", () => {
		expect(
			summarize([
				row({ prNumber: 1, totalMs: 60_000 }),
				row({ prNumber: 2, totalMs: 180_000 }),
			]).mttrToPrMinutes,
		).toBe(2);
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
});
