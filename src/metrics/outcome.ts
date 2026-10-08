// Fills in the outcome of a run's PR once the PR is closed. Called from the Action on
// `pull_request: closed`.
import type { DataStore } from "../memory/datastore.js";
import { LEDGER_PATH, readRecords } from "./ledger.js";

export interface PullOutcome {
	prNumber: number;
	merged: boolean;
	/** The PR's title: kept on the row, and used to spot a later revert PR. */
	title?: string;
}

const REVERT_PREFIX = 'Revert "';

/**
 * Sets the row for `prNumber` to merged or closed. A merged PR titled `Revert "<title>"` also marks
 * the earlier merged row with that title as reverted. Returns whether any row changed.
 * With retries a PR can have several rows; the latest one carries the outcome.
 * The file is rewritten from the valid rows, so a corrupt line is dropped.
 */
export async function recordPullRequestOutcome(
	store: DataStore,
	{ prNumber, merged, title }: PullOutcome,
): Promise<boolean> {
	const records = await readRecords(store);

	const own = records.filter((r) => r.prNumber === prNumber).at(-1);

	let changed = false;

	if (own) {
		own.outcome = merged ? "merged" : "closed";
		own.prTitle = title ?? own.prTitle;
		changed = true;
	}

	if (merged && title?.startsWith(REVERT_PREFIX)) {
		for (const r of records) {
			if (
				r !== own &&
				r.outcome === "merged" &&
				r.prTitle &&
				title.includes(r.prTitle)
			) {
				r.outcome = "reverted";
				changed = true;
			}
		}
	}

	if (changed) {
		await store.write(
			LEDGER_PATH,
			`${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
		);
	}

	return changed;
}
