import type { DataStore } from "../memory/datastore.js";
import {
	journalHints,
	keywordsFrom,
	retrieveJournal,
} from "../memory/journal.js";
import type { RunContext } from "./run.js";

/**
 * Notes from earlier runs that are relevant to this one, as text for the model. Undefined when there
 * is no store, nothing relevant, or the store cannot be read: hints are a bonus, never a reason to
 * fail a run.
 */
export async function hintsFor(
	store: DataStore | undefined,
	ctx: RunContext,
): Promise<string | undefined> {
	if (!store) return undefined;

	try {
		const entries = await retrieveJournal(store, {
			area: ctx.artifacts.intake?.area ?? "unknown",
			files: [],
			keywords: keywordsFrom(ctx.issue.title),
		});

		return journalHints(entries) || undefined;
	} catch {
		return undefined;
	}
}
