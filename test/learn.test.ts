import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.js";
import { type DataStore, localDataStore } from "../src/memory/datastore.js";
import { writeJournalEntry } from "../src/memory/journal.js";
import { hintsFor } from "../src/pipeline/hints.js";
import { learnFromRun } from "../src/pipeline/learn.js";
import type { RunContext } from "../src/pipeline/run.js";

const config = parseConfig(
	"app:\n  up: x\n  base_url: http://localhost:3456\ntests:\n  full: 'true'\n",
);

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
			stageMs: { Intake: 5 },
			spentUsd: 0.02,
			store,
		});

		expect(problems).toEqual([]);
		expect((await store.list("journal")).length).toBe(1);
		expect(await store.read("ledger/runs.jsonl")).toContain(
			'"runId":"local-1"',
		);
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
			stageMs: {},
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
			stageMs: {},
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
