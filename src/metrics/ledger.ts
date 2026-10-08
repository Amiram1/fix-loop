// The run ledger: one JSON line per run in `ledger/runs.jsonl`, plus the aggregates PLAN.md
// section 5 asks for. The PR outcome handler (outcome.ts) fills in `outcome` later.
import type { DataStore } from "../memory/datastore.js";
import type { Area, Delivery, Severity } from "../pipeline/artifacts.js";
import type { RunContext, RunResult, StageRecord } from "../pipeline/run.js";

export const LEDGER_PATH = "ledger/runs.jsonl";

export type Outcome = "open" | "merged" | "closed" | "reverted";

const OUTCOMES: readonly string[] = ["open", "merged", "closed", "reverted"];

/** How the run ended: no stage failed or halted, a stage halted, a stage failed, or it was stopped. */
export type RunStatus = "completed" | "halted" | "failed" | "stopped";

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
	/** How each stage ended, copied from RunResult. Absent on rows written before stages were recorded. */
	stages?: StageRecord[];
	status?: RunStatus;
	/** The stage that threw. Set when status is "failed". */
	failedStage?: string;
	/** When the issue was opened (ISO). */
	issueCreatedAt?: string;
	/** When the run opened or updated a PR (ISO). Time to PR is this minus issueCreatedAt. */
	prOpenedAt?: string;
	/**
	 * Comments by people (not bots) on the issue since the run started. Null when not counted
	 * (dry runs and the CLI): it must not read as "no one touched it".
	 */
	humanTouches: number | null;
	/** Set when the run opened or updated a PR. */
	prNumber?: number;
	branch?: string;
	/** The PR's title, kept when its outcome arrives so a later revert PR can be matched to it. */
	prTitle?: string;
	outcome: Outcome;
}

/**
 * Builds the row from what the stages left in `ctx.artifacts` and the run's result. Missing
 * artifacts are fine: a run that stopped early still gets a row. `spentUsd` is the budget's total
 * for the run; without it the cost is the sum of the stages that report one (Intake does not).
 * `humanTouches` stays null unless the caller counted them.
 */
export function recordFrom(
	ctx: RunContext,
	runId: string,
	{ stageMs, stages }: Pick<RunResult, "stageMs" | "stages">,
	spentUsd?: number,
	humanTouches: number | null = null,
): RunRecord {
	const { intake, reproduction, fix, gate, delivery } = ctx.artifacts;

	// Read loosely so this compiles whether or not the artifacts type has the field yet.
	const stopped = (ctx.artifacts as { stopped?: unknown } | undefined)
		?.stopped;

	const failedStage = stages.find((s) => s.state === "failed")?.name;

	const now = new Date().toISOString();

	const hasPr =
		delivery?.status === "pr_opened" || delivery?.status === "pr_updated";

	const prNumber = hasPr
		? Number(/\/pull\/(\d+)/.exec(delivery.url ?? "")?.[1]) || undefined
		: undefined;

	return {
		runId,
		issue: ctx.issue.number,
		createdAt: now,
		area: intake?.area,
		severity: intake?.severity,
		delivery: gate?.delivery,
		reproduced: reproduction?.status === "reproduced",
		fixAttempts: fix?.attempts ?? 0,
		models: fix?.models ?? [],
		costUsd: spentUsd ?? (reproduction?.costUsd ?? 0) + (fix?.costUsd ?? 0),
		stageMs,
		totalMs: Object.values(stageMs).reduce((a, b) => a + b, 0),
		stages,
		status: stopped
			? "stopped"
			: failedStage
				? "failed"
				: stages.some((s) => s.state === "halted")
					? "halted"
					: "completed",
		failedStage,
		issueCreatedAt: ctx.issue.issueCreatedAt,
		// Learn runs right after Deliver, so now is when the PR was opened.
		prOpenedAt: hasPr ? now : undefined,
		humanTouches,
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
	/** Median minutes from the issue opening to the PR opening, over rows with both times. */
	mttrToPrMinutes: number | undefined;
	/** Median run duration in minutes, over the runs that opened a PR. Undefined when none did. */
	medianRunMinutes: number | undefined;
	/** Share of runs that got a red test. */
	reproductionRate: number;
	/** merged / (merged + closed). */
	prMergeRate: number;
	meanCostUsd: number;
	/** Share of runs with no human touches, among runs that have a count. Undefined when none do. */
	noHumanShare: number | undefined;
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

/** Minutes from the issue opening to the PR opening. Undefined unless the row has both times. */
export function minutesToPr(r: RunRecord): number | undefined {
	const ms =
		Date.parse(r.prOpenedAt ?? "") - Date.parse(r.issueCreatedAt ?? "");

	// NaN (a missing or bad time) and a negative gap both fail this and are left out.
	return ms >= 0 ? ms / 60_000 : undefined;
}

export function summarize(records: RunRecord[]): Summary {
	const count = (outcome: Outcome) =>
		records.filter((r) => r.outcome === outcome).length;

	// Open PRs have no verdict yet and reverted ones are left out on purpose: the rate is
	// merged / (merged + closed). A reverted PR shows in its row's outcome, not in this rate.
	const merged = count("merged");

	const runMs = median(
		records.filter((r) => r.prNumber !== undefined).map((r) => r.totalMs),
	);

	// Old rows always said 0 and null means "not counted": only real counts go in the share.
	const counted = records.filter((r) => typeof r.humanTouches === "number");

	return {
		runs: records.length,
		mttrToPrMinutes: median(records.flatMap((r) => minutesToPr(r) ?? [])),
		medianRunMinutes: runMs === undefined ? undefined : runMs / 60_000,
		reproductionRate: share(
			records.filter((r) => r.reproduced).length,
			records.length,
		),
		prMergeRate: share(merged, merged + count("closed")),
		meanCostUsd: share(
			records.reduce((sum, r) => sum + r.costUsd, 0),
			records.length,
		),
		noHumanShare: counted.length
			? share(
					counted.filter((r) => r.humanTouches === 0).length,
					counted.length,
				)
			: undefined,
		escalated: records.filter((r) => r.models.length > 1).length,
	};
}
