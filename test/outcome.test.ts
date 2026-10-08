import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localDataStore } from "../src/memory/datastore.js";
import {
	appendRecord,
	LEDGER_PATH,
	type RunRecord,
	readRecords,
} from "../src/metrics/ledger.js";
import { recordPullRequestOutcome } from "../src/metrics/outcome.js";

const row = (over: Partial<RunRecord>): RunRecord => ({
	runId: "r",
	issue: 1,
	createdAt: "2026-10-01T00:00:00.000Z",
	reproduced: true,
	fixAttempts: 1,
	models: ["haiku"],
	costUsd: 0.1,
	stageMs: {},
	totalMs: 1000,
	humanTouches: 0,
	outcome: "open",
	...over,
});

describe("recordPullRequestOutcome", () => {
	let root: string;

	let store: ReturnType<typeof localDataStore>;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "fixloop-outcome-"));
		store = localDataStore(root);
		await appendRecord(store, row({ runId: "a", issue: 1, prNumber: 10 }));
		await appendRecord(store, row({ runId: "b", issue: 2, prNumber: 11 }));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	const outcomes = async () =>
		(await readRecords(store)).map((r) => [r.runId, r.outcome]);

	it("marks the PR's row merged or closed", async () => {
		expect(
			await recordPullRequestOutcome(store, {
				prNumber: 10,
				merged: true,
				title: "Fix #1: a",
			}),
		).toBe(true);
		expect(
			await recordPullRequestOutcome(store, {
				prNumber: 11,
				merged: false,
			}),
		).toBe(true);

		expect(await outcomes()).toEqual([
			["a", "merged"],
			["b", "closed"],
		]);
		expect((await readRecords(store))[0]?.prTitle).toBe("Fix #1: a");
	});

	it("returns false and leaves the file alone when no row has the PR", async () => {
		const before = await store.read(LEDGER_PATH);

		expect(
			await recordPullRequestOutcome(store, {
				prNumber: 99,
				merged: true,
			}),
		).toBe(false);
		expect(await store.read(LEDGER_PATH)).toBe(before);
	});

	it("returns false when there is no ledger yet", async () => {
		const empty = localDataStore(join(root, "elsewhere"));

		expect(
			await recordPullRequestOutcome(empty, {
				prNumber: 10,
				merged: true,
			}),
		).toBe(false);
		expect(await empty.read(LEDGER_PATH)).toBeUndefined();
	});

	it("updates the latest row when a retry gave the PR a second row", async () => {
		await appendRecord(store, row({ runId: "a2", issue: 1, prNumber: 10 }));

		await recordPullRequestOutcome(store, { prNumber: 10, merged: true });

		expect(await outcomes()).toEqual([
			["a", "open"],
			["b", "open"],
			["a2", "merged"],
		]);
	});

	it("marks the earlier merged PR reverted when a merged revert PR arrives", async () => {
		await recordPullRequestOutcome(store, {
			prNumber: 10,
			merged: true,
			title: "Fix #1: tasks vanish",
		});

		// The revert PR is not one of ours, so it has no row of its own: the earlier row is the change.
		expect(
			await recordPullRequestOutcome(store, {
				prNumber: 20,
				merged: true,
				title: 'Revert "Fix #1: tasks vanish"',
			}),
		).toBe(true);

		expect(await outcomes()).toEqual([
			["a", "reverted"],
			["b", "open"],
		]);
	});

	it("does not revert on an unrelated, unmerged or non-revert title", async () => {
		await recordPullRequestOutcome(store, {
			prNumber: 10,
			merged: true,
			title: "Fix #1: tasks vanish",
		});

		for (const input of [
			{ prNumber: 20, merged: true, title: 'Revert "Something else"' },
			{
				prNumber: 21,
				merged: false,
				title: 'Revert "Fix #1: tasks vanish"',
			},
			{
				prNumber: 22,
				merged: true,
				title: "Follow-up to Fix #1: tasks vanish",
			},
		]) {
			expect(await recordPullRequestOutcome(store, input)).toBe(false);
		}

		expect(await outcomes()).toEqual([
			["a", "merged"],
			["b", "open"],
		]);
	});

	it("does not revert a PR that was only closed", async () => {
		await recordPullRequestOutcome(store, {
			prNumber: 10,
			merged: false,
			title: "Fix #1: tasks vanish",
		});

		await recordPullRequestOutcome(store, {
			prNumber: 20,
			merged: true,
			title: 'Revert "Fix #1: tasks vanish"',
		});

		expect((await outcomes())[0]).toEqual(["a", "closed"]);
	});
});
