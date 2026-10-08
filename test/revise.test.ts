import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config/load.js";
import type { DataStore } from "../src/memory/datastore.js";
import type { JournalEntry } from "../src/memory/journal.js";
import {
	fetchBranch,
	prepareRevise,
	reproductionFromJournal,
	withEscalation,
} from "../src/pipeline/revise.js";

const exec = promisify(execFile);

const config = parseConfig(
	"app:\n  up: x\n  base_url: http://localhost:3456\ntests:\n  full: make test\nmodels:\n  fix: cheap-model\n  escalate: strong-model\neffort:\n  fix: low\n  escalate: high\n",
);

describe("withEscalation", () => {
	it("puts the escalation model and effort on the fix stage", () => {
		const out = withEscalation(config);

		expect(out.models.fix).toBe("strong-model");
		expect(out.effort.fix).toBe("high");
	});

	it("changes nothing else and leaves the original alone", () => {
		const out = withEscalation(config);

		expect(out.models).toEqual({ ...config.models, fix: "strong-model" });
		expect(out.effort).toEqual({ ...config.effort, fix: "high" });
		expect(out.budget).toEqual(config.budget);
		expect(config.models.fix).toBe("cheap-model");
		expect(config.effort.fix).toBe("low");
	});
});

const entry = (over: Partial<JournalEntry> = {}): JournalEntry => ({
	runId: "r1",
	issue: 7,
	createdAt: "2026-01-01T00:00:00.000Z",
	area: "backend",
	severity: "S3",
	title: "Tasks vanish",
	outcome: "fixed",
	rootCause: "",
	files: [],
	testPath: "pkg/task_test.go",
	testName: "TestVanish",
	testContent: "package pkg\n",
	reproRecipe: "",
	models: [],
	costUsd: 0,
	...over,
});

function fakeStore(entries: JournalEntry[]): DataStore {
	const files = new Map(
		entries.map((e) => [
			`journal/${e.issue}-${e.runId}.json`,
			JSON.stringify(e),
		]),
	);

	return {
		read: async (f) => files.get(f),
		write: async () => {},
		list: async () => [...files.keys()].sort(),
	};
}

describe("reproductionFromJournal", () => {
	it("builds a reproduced reproduction from the newest entry that kept a test", async () => {
		const store = fakeStore([
			entry({ runId: "old", testContent: "old test" }),
			entry({
				runId: "new",
				createdAt: "2026-03-01T00:00:00.000Z",
				testContent: "new test",
				area: "frontend",
			}),
			// Newest of all, but a run that never reproduced the bug has no test to reuse.
			entry({
				runId: "newest",
				createdAt: "2026-04-01T00:00:00.000Z",
				outcome: "not_reproduced",
				testPath: undefined,
				testName: undefined,
				testContent: undefined,
			}),
			entry({ issue: 70, runId: "other", testContent: "other issue" }),
		]);

		expect(await reproductionFromJournal(store, 7)).toEqual({
			status: "reproduced",
			area: "frontend",
			testPath: "pkg/task_test.go",
			testName: "TestVanish",
			testContent: "new test",
			attempts: 0,
			costUsd: 0,
		});
	});

	it("is undefined with no entry, no stored test, or an unknown area", async () => {
		expect(await reproductionFromJournal(fakeStore([]), 7)).toBeUndefined();
		expect(
			await reproductionFromJournal(
				fakeStore([entry({ testContent: undefined })]),
				7,
			),
		).toBeUndefined();
		expect(
			await reproductionFromJournal(
				fakeStore([entry({ area: "unknown" })]),
				7,
			),
		).toBeUndefined();
	});
});

describe("prepareRevise", () => {
	const base = { root: "/repo", headRef: "fixloop/issue-7", issue: 7 };

	it("fetches the branch, then returns the first run's red test", async () => {
		const fetch = vi.fn(async () => {});

		const plan = await prepareRevise({
			...base,
			store: fakeStore([entry()]),
			fetch,
		});

		expect(fetch).toHaveBeenCalledWith("/repo", "fixloop/issue-7");
		expect(plan).toMatchObject({
			ok: true,
			reproduction: { status: "reproduced", testName: "TestVanish" },
		});
	});

	it("stops with a message when the branch cannot be fetched", async () => {
		const plan = await prepareRevise({
			...base,
			store: fakeStore([entry()]),
			fetch: async () => {
				throw new Error("couldn't find remote ref");
			},
		});

		expect(plan.ok).toBe(false);
		expect(!plan.ok && plan.message).toMatch(/could not fetch the branch/);
		expect(!plan.ok && plan.message).toContain("couldn't find remote ref");
	});

	it("stops with a message when there is no record of the first run", async () => {
		const plan = await prepareRevise({
			...base,
			store: fakeStore([]),
			fetch: async () => {},
		});

		expect(plan.ok).toBe(false);
		expect(!plan.ok && plan.message).toMatch(
			/needs the first run's record/,
		);
	});
});

describe("fetchBranch", () => {
	let dir: string;

	const git = (cwd: string, ...args: string[]) =>
		exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
			cwd,
		}).then((r) => r.stdout.trim());

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "fixloop-revise-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("brings the PR branch's commit into the checkout, and fails for a missing branch", async () => {
		const origin = join(dir, "origin");

		const work = join(dir, "work");

		await exec("git", ["init", "-q", "-b", "main", origin]);
		await writeFile(join(origin, "a.txt"), "one\n");
		await git(origin, "add", ".");
		await git(origin, "commit", "-qm", "init");
		await exec("git", ["clone", "-q", origin, work]);

		await git(origin, "checkout", "-qb", "fixloop/issue-7");
		await writeFile(join(origin, "a.txt"), "two\n");
		await git(origin, "commit", "-qam", "fix");

		const sha = await git(origin, "rev-parse", "HEAD");

		await expect(git(work, "cat-file", "-e", sha)).rejects.toThrow();

		await fetchBranch(work, "fixloop/issue-7");

		await expect(git(work, "cat-file", "-e", sha)).resolves.toBe("");
		await expect(fetchBranch(work, "fixloop/issue-8")).rejects.toThrow();
	});
});
