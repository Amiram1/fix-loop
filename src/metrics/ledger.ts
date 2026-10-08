// The run ledger: one JSON line per run in `ledger/runs.jsonl`, plus the aggregates PLAN.md
// section 5 asks for. The PR outcome handler (outcome.ts) fills in `outcome` later.
import type { DataStore } from "../memory/datastore.js";
import type { Area, Delivery, Severity } from "../pipeline/artifacts.js";
import type { RunContext } from "../pipeline/run.js";

export const LEDGER_PATH = "ledger/runs.jsonl";

export type Outcome = "open" | "merged" | "closed" | "reverted";

const OUTCOMES: readonly string[] = ["open", "merged", "closed", "reverted"];

export interface RunRecord {
	runId: string;
	issue: number;
	createdAt: string;
	area?: Area;
	severity?: Severity;
	/** What the gate decided. Unset when the run ended before the gate. */
	delivery?: Delivery;
	reproduced: boolean;
	fixAttempts: number;
	/** Models the fix used, in order. More than one means the run escalated. */
	models: string[];
	costUsd: number;
	/** Wall-clock milliseconds per stage, copied from RunResult. */
	stageMs: Record<string, number>;
	totalMs: number;
	/** Not measured yet: always 0 until there is a way to see a person step in. */
	humanTouches: number;
	/** Set when the run opened or updated a PR. */
	prNumber?: number;
	branch?: string;
	/** The PR's title, kept when its outcome arrives so a later revert PR can be matched to it. */
	prTitle?: string;
	outcome: Outcome;
}

/**
 * Builds the row from what the stages left in `ctx.artifacts`. Missing artifacts are fine: a run
 * that stopped early still gets a row. `spentUsd` is the budget's total for the run; without it
 * the cost is the sum of the stages that report one (Intake does not).
 */
export function recordFrom(
	ctx: RunContext,
	runId: string,
	stageMs: Record<string, number>,
	spentUsd?: number,
): RunRecord {
	const { intake, reproduction, fix, gate, delivery } = ctx.artifacts;

	const hasPr =
		delivery?.status === "pr_opened" || delivery?.status === "pr_updated";

	const prNumber = hasPr
		? Number(/\/pull\/(\d+)/.exec(delivery.url ?? "")?.[1]) || undefined
		: undefined;

	return {
		runId,
		issue: ctx.issue.number,
		createdAt: new Date().toISOString(),
		area: intake?.area,
		severity: intake?.severity,
		delivery: gate?.delivery,
		reproduced: reproduction?.status === "reproduced",
		fixAttempts: fix?.attempts ?? 0,
		models: fix?.models ?? [],
		costUsd: spentUsd ?? (reproduction?.costUsd ?? 0) + (fix?.costUsd ?? 0),
		stageMs,
		totalMs: Object.values(stageMs).reduce((a, b) => a + b, 0),
		humanTouches: 0,
		prNumber,
		branch: hasPr ? delivery.branch : undefined,
		outcome: "open",
	};
}

function isRecord(row: unknown): row is RunRecord {
	const r = row as Partial<RunRecord> | null;

	return (
		typeof r === "object" &&
		r !== null &&
		typeof r.runId === "string" &&
		typeof r.issue === "number" &&
		typeof r.totalMs === "number" &&
		typeof r.costUsd === "number" &&
		typeof r.outcome === "string" &&
		OUTCOMES.includes(r.outcome) &&
		Array.isArray(r.models)
	);
}

/** Rows that are not valid records are skipped, not reported. */
export async function readRecords(store: DataStore): Promise<RunRecord[]> {
	const text = (await store.read(LEDGER_PATH)) ?? "";

	return text.split("\n").flatMap((line) => {
		try {
			const row: unknown = JSON.parse(line);

			return isRecord(row) ? [row] : [];
		} catch {
			return [];
		}
	});
}

export async function appendRecord(
	store: DataStore,
	record: RunRecord,
): Promise<void> {
	const text = (await store.read(LEDGER_PATH)) ?? "";

	const gap = text && !text.endsWith("\n") ? "\n" : "";

	await store.write(LEDGER_PATH, `${text}${gap}${JSON.stringify(record)}\n`);
}

export interface Summary {
	runs: number;
	/** Median minutes from start to PR over the runs that opened one. Undefined when none did. */
	mttrToPrMinutes: number | undefined;
	/** Share of runs that got a red test. */
	reproductionRate: number;
	/** merged / (merged + closed). */
	prMergeRate: number;
	meanCostUsd: number;
	/** Share of runs with no human touches. Always 1 while humanTouches is not measured. */
	noHumanShare: number;
	/** Runs that moved to a second model. */
	escalated: number;
}

/** part / whole, with 0 for an empty whole. */
const share = (part: number, whole: number) => (whole ? part / whole : 0);

function median(values: number[]): number | undefined {
	const sorted = [...values].sort((a, b) => a - b);

	const mid = sorted.length >> 1;

	if (!sorted.length) return undefined;

	return sorted.length % 2
		? sorted[mid]
		: ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

export function summarize(records: RunRecord[]): Summary {
	const count = (outcome: Outcome) =>
		records.filter((r) => r.outcome === outcome).length;

	// Open PRs have no verdict yet and reverted ones are left out on purpose: the rate is
	// merged / (merged + closed). A reverted PR shows in its row's outcome, not in this rate.
	const merged = count("merged");

	const mttrMs = median(
		records.filter((r) => r.prNumber !== undefined).map((r) => r.totalMs),
	);

	return {
		runs: records.length,
		mttrToPrMinutes: mttrMs === undefined ? undefined : mttrMs / 60_000,
		reproductionRate: share(
			records.filter((r) => r.reproduced).length,
			records.length,
		),
		prMergeRate: share(merged, merged + count("closed")),
		meanCostUsd: share(
			records.reduce((sum, r) => sum + r.costUsd, 0),
			records.length,
		),
		noHumanShare: share(
			records.filter((r) => r.humanTouches === 0).length,
			records.length,
		),
		escalated: records.filter((r) => r.models.length > 1).length,
	};
}
