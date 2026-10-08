import type { DataStore } from "../memory/datastore.js";
import { journalEntryFrom, writeJournalEntry } from "../memory/journal.js";
import { appendRecord, recordFrom } from "../metrics/ledger.js";
import type { RunContext } from "./run.js";

export interface LearnInput {
	ctx: RunContext;
	runId: string;
	stageMs: Record<string, number>;
	/** The run's total model spend, from the budget. */
	spentUsd: number;
	store: DataStore;
}

/**
 * Keeps what this run learned: a journal entry that later runs can retrieve, and a ledger row for
 * the metrics. It runs after the pipeline. A failed write is returned as a problem, never thrown,
 * so it cannot change the outcome of the run.
 */
export async function learnFromRun(input: LearnInput): Promise<string[]> {
	const { ctx, runId, stageMs, spentUsd, store } = input;

	const problems: string[] = [];

	try {
		await writeJournalEntry(store, journalEntryFrom(ctx, runId));
	} catch (err) {
		problems.push(`journal not written: ${(err as Error).message}`);
	}

	try {
		await appendRecord(store, recordFrom(ctx, runId, stageMs, spentUsd));
	} catch (err) {
		problems.push(`ledger row not written: ${(err as Error).message}`);
	}

	return problems;
}
