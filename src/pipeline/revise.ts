// Helpers for the maintainer commands that change how a run starts: escalate, and the
// review-feedback pass ("revise").
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FixLoopConfig } from "../config/schema.js";
import type { DataStore } from "../memory/datastore.js";
import { type JournalEntry, latestJournalEntry } from "../memory/journal.js";
import type { Reproduction } from "./artifacts.js";

const execFileP = promisify(execFile);

/** `/fixloop escalate`: the fix stage runs on the escalation model and effort. For this run only; the file is not touched. */
export function withEscalation(config: FixLoopConfig): FixLoopConfig {
	return {
		...config,
		models: { ...config.models, fix: config.models.escalate },
		effort: { ...config.effort, fix: config.effort.escalate },
	};
}

/** Brings the PR branch's commits into `root`'s object store, so a scratch clone of `root` can check the head out. */
export async function fetchBranch(root: string, ref: string): Promise<void> {
	await execFileP("git", ["fetch", "--quiet", "origin", ref], { cwd: root });
}

/** The red test an entry kept, as a reproduction. Undefined for an entry with no usable test. */
function reproductionOf(entry: JournalEntry): Reproduction | undefined {
	if (
		entry.area === "unknown" ||
		!entry.testPath ||
		!entry.testName ||
		entry.testContent === undefined
	) {
		return undefined;
	}

	return {
		status: "reproduced",
		area: entry.area,
		testPath: entry.testPath,
		testName: entry.testName,
		testContent: entry.testContent,
		attempts: 0,
		costUsd: 0,
	};
}

/**
 * The first run's red test, from the newest journal entry for `issue` that kept one. Undefined when
 * no run recorded a test the revision could reuse.
 */
export async function reproductionFromJournal(
	store: DataStore,
	issue: number,
): Promise<Reproduction | undefined> {
	const entry = await latestJournalEntry(
		store,
		issue,
		(e) => reproductionOf(e) !== undefined,
	);

	return entry && reproductionOf(entry);
}

export type RevisePlan =
	| { ok: true; reproduction: Reproduction }
	| { ok: false; message: string };

/**
 * What a review-feedback pass needs before the pipeline starts: the PR branch fetched, and the first
 * run's red test. A failure carries the comment to post.
 */
export async function prepareRevise(deps: {
	root: string;
	store: DataStore;
	headRef: string;
	issue: number;
	/** Injectable for tests. */
	fetch?: (root: string, ref: string) => Promise<void>;
}): Promise<RevisePlan> {
	try {
		await (deps.fetch ?? fetchBranch)(deps.root, deps.headRef);
	} catch (err) {
		return {
			ok: false,
			message: `FixLoop could not fetch the branch \`${deps.headRef}\`, so it cannot revise the pull request: ${(err as Error).message}`,
		};
	}

	const reproduction = await reproductionFromJournal(deps.store, deps.issue);

	if (!reproduction) {
		return {
			ok: false,
			message: `A revision needs the first run's record of the red test for #${deps.issue}, and none was found. Use \`/fixloop retry\` on the issue to start over.`,
		};
	}

	return { ok: true, reproduction };
}
