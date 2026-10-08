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

/**
 * GitHub's default title for a revert PR. Matched whole, so `Revert "Fix #10: x"` cannot revert
 * the row for `Fix #1`.
 */
const revertTitle = (original: string) => `Revert "${original}"`;

/**
 * Sets the row for `prNumber` to merged or closed. A merged PR titled `Revert "<title>"` also marks
 * the earlier merged row with that title as reverted. Returns whether any row changed.
 * A revert PR is not on a `fixloop/` branch and has no row of its own. Routing those PRs here is the
 * router's job (it is being changed separately); this handler must accept them when they arrive.
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

	if (merged && title) {
		for (const r of records) {
			if (
				r !== own &&
				r.outcome === "merged" &&
				r.prTitle &&
				title === revertTitle(r.prTitle)
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
