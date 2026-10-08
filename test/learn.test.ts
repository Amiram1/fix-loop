import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.js";
import { type DataStore, localDataStore } from "../src/memory/datastore.js";
import { writeJournalEntry } from "../src/memory/journal.js";
import { readRecords } from "../src/metrics/ledger.js";
import { hintsFor } from "../src/pipeline/hints.js";
import { learnFromRun } from "../src/pipeline/learn.js";
import type { RunContext, RunResult } from "../src/pipeline/run.js";

const config = parseConfig(
	"app:\n  up: x\n  base_url: http://localhost:3456\ntests:\n  full: 'true'\n",
);

const result = (stageMs: Record<string, number> = {}): RunResult => ({
	ok: true,
	startedAt: "2026-10-01T00:00:00.000Z",
	stageMs,
	stages: Object.keys(stageMs).map((name) => ({
		name,
		state: "done" as const,
	})),
});

function ctxWith(): RunContext {
	return {
		runId: "local-1",
		config,
		issue: { number: 4, title: "Tasks vanish after login", body: "" },
		dryRun: true,
		artifacts: {
			intake: {
				area: "backend",
				severity: "S2",
				summary: "s",
				injectionSuspected: false,
			},
			reproduction: {
				status: "reproduced",
				area: "backend",
				testPath: "pkg/x_test.go",
				testName: "TestReproVanish",
				evidence: "--- FAIL: TestReproVanish\nexpected 1 got 0",
				attempts: 1,
				costUsd: 0.01,
			},
		},
	};
}

describe("learnFromRun", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "fixloop-learn-"));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("writes a journal entry and a ledger row to the store", async () => {
		const store = localDataStore(root);

		const problems = await learnFromRun({
			ctx: ctxWith(),
			runId: "local-1",
			result: result({ Intake: 5 }),
			spentUsd: 0.02,
			store,
		});

		expect(problems).toEqual([]);
		expect((await store.list("journal")).length).toBe(1);
		expect(await store.read("ledger/runs.jsonl")).toContain(
			'"runId":"local-1"',
		);
	});

	it("writes the dashboard from the ledger, after the row is appended", async () => {
		const store = localDataStore(root);

		await learnFromRun({
			ctx: ctxWith(),
			runId: "local-1",
			result: result({ Intake: 5 }),
			spentUsd: 0.02,
			store,
		});

		const dashboard = await store.read("dashboard.md");

		expect(dashboard).toContain("# FixLoop dashboard");
		expect(dashboard).toContain("| Runs | 1 |");
		expect(dashboard).toContain("| #4 |");
	});

	it("records human touches as null without a counter and as counted with one", async () => {
		const store = localDataStore(root);

		const run = (countHumanTouches?: () => Promise<number>) =>
			learnFromRun({
				ctx: ctxWith(),
				runId: "r",
				result: result(),
				spentUsd: 0,
				store,
				countHumanTouches,
			});

		expect(await run()).toEqual([]);
		expect(await run(async () => 0)).toEqual([]);
		expect(await run(async () => 2)).toEqual([]);

		expect((await readRecords(store)).map((r) => r.humanTouches)).toEqual([
			null,
			0,
			2,
		]);
	});

	it("keeps the row, with null touches, when counting fails", async () => {
		const store = localDataStore(root);

		const problems = await learnFromRun({
			ctx: ctxWith(),
			runId: "r",
			result: result(),
			spentUsd: 0,
			store,
			countHumanTouches: async () => {
				throw new Error("rate limited");
			},
		});

		expect(problems).toEqual(["human touches not counted: rate limited"]);
		expect((await readRecords(store))[0]?.humanTouches).toBeNull();
	});

	it("reports a failed dashboard write as a problem and still has the row", async () => {
		const store = localDataStore(root);

		const problems = await learnFromRun({
			ctx: ctxWith(),
			runId: "r",
			result: result(),
			spentUsd: 0,
			store: {
				...store,
				write: async (file, text) => {
					if (file === "dashboard.md") throw new Error("no room");

					await store.write(file, text);
				},
			},
		});

		expect(problems).toEqual(["dashboard not written: no room"]);
		expect(await readRecords(store)).toHaveLength(1);
	});

	it("reports a failed write as a problem instead of throwing", async () => {
		const broken: DataStore = {
			read: async () => undefined,
			write: async () => {
				throw new Error("disk full");
			},
			list: async () => [],
		};

		const problems = await learnFromRun({
			ctx: ctxWith(),
			runId: "local-1",
			result: result(),
			spentUsd: 0,
			store: broken,
		});

		expect(problems).toHaveLength(2);
		expect(problems[0]).toMatch(/journal not written: disk full/);
	});
});

describe("hintsFor", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "fixloop-hints-"));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("is undefined without a store", async () => {
		expect(await hintsFor(undefined, ctxWith())).toBeUndefined();
	});

	it("returns notes from a similar earlier run", async () => {
		const store = localDataStore(root);

		await learnFromRun({
			ctx: ctxWith(),
			runId: "earlier",
			result: result(),
			spentUsd: 0,
			store,
		});

		const hints = await hintsFor(store, ctxWith());

		expect(hints).toContain("Tasks vanish after login");
		expect(hints).toContain("Notes from earlier runs");
	});

	it("is undefined when the store cannot be read, so a run is never failed by hints", async () => {
		const broken: DataStore = {
			read: async () => undefined,
			write: async () => {},
			list: async () => {
				throw new Error("network down");
			},
		};

		expect(await hintsFor(broken, ctxWith())).toBeUndefined();
	});

	it("is undefined when no earlier entry is relevant", async () => {
		const store = localDataStore(root);

		await writeJournalEntry(store, {
			...(await import("../src/memory/journal.js")).journalEntryFrom(
				ctxWith(),
				"old",
			),
			area: "frontend",
			title: "Dark mode flickers",
			files: ["frontend/src/theme.ts"],
		});

		const unrelated = ctxWith();

		unrelated.issue.title = "Export button missing";

		expect(await hintsFor(store, unrelated)).toBeUndefined();
	});
});
