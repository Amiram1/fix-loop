import type { DataStore } from "../memory/datastore.js";
import { journalEntryFrom, writeJournalEntry } from "../memory/journal.js";
import { DASHBOARD_PATH, renderDashboard } from "../metrics/dashboard.js";
import { appendRecord, readRecords, recordFrom } from "../metrics/ledger.js";
import type { RunContext, RunResult } from "./run.js";

export interface LearnInput {
	ctx: RunContext;
	runId: string;
	result: RunResult;
	/** The run's total model spend, from the budget. */
	spentUsd: number;
	store: DataStore;
	/** Counts human comments since the run started. Without it (dry runs, the CLI) the row says null. */
	countHumanTouches?: () => Promise<number>;
}

/**
 * Keeps what this run learned: a journal entry that later runs can retrieve, a ledger row for
 * the metrics and the dashboard built from the ledger. It runs after the pipeline. A failed write
 * is returned as a problem, never thrown, so it cannot change the outcome of the run.
 */
export async function learnFromRun(input: LearnInput): Promise<string[]> {
	const { ctx, runId, result, spentUsd, store, countHumanTouches } = input;

	const problems: string[] = [];

	try {
		await writeJournalEntry(store, journalEntryFrom(ctx, runId));
	} catch (err) {
		problems.push(`journal not written: ${(err as Error).message}`);
	}

	let humanTouches: number | null = null;

	try {
		humanTouches = (await countHumanTouches?.()) ?? null;
	} catch (err) {
		problems.push(`human touches not counted: ${(err as Error).message}`);
	}

	try {
		await appendRecord(
			store,
			recordFrom(ctx, runId, result, spentUsd, humanTouches),
		);
	} catch (err) {
		problems.push(`ledger row not written: ${(err as Error).message}`);

		return problems;
	}

	try {
		await store.write(
			DASHBOARD_PATH,
			renderDashboard(await readRecords(store), new Date()),
		);
	} catch (err) {
		problems.push(`dashboard not written: ${(err as Error).message}`);
	}

	return problems;
}
