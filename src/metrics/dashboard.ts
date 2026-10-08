// The dashboard (PLAN.md D3): the ledger as one Markdown page, written to `dashboard.md` on the
// data branch after every run.
import { minutesToPr, type RunRecord, summarize } from "./ledger.js";

export const DASHBOARD_PATH = "dashboard.md";

const RECENT_RUNS = 20;

export const percent = (n: number) => `${Math.round(n * 100)}%`;

/**
 * One table cell. Record fields come from a file on a branch anyone with write access can edit, so
 * a pipe or a line break must not be able to add a column or a row. Titles are not shown at all.
 */
const cell = (value: unknown) =>
	String(value ?? "-")
		.replace(/\s+/g, " ")
		.replace(/\|/g, "¦");

const minutes = (m: number | undefined) =>
	m === undefined ? "n/a" : `${m.toFixed(1)} min`;

const table = (header: string[], rows: unknown[][]) =>
	[header, header.map(() => "---"), ...rows]
		.map((r) => `| ${r.map(cell).join(" | ")} |`)
		.join("\n");

export function renderDashboard(records: RunRecord[], now: Date): string {
	const s = summarize(records);

	const empty = s.runs === 0;

	const na = (value: string) => (empty ? "n/a" : value);

	const counted = records.filter((r) => typeof r.humanTouches === "number");

	const summary = table(
		["Metric", "Value"],
		[
			["Runs", s.runs],
			["Median time to PR", minutes(s.mttrToPrMinutes)],
			["Median run time", minutes(s.medianRunMinutes)],
			["Reproduction rate", na(percent(s.reproductionRate))],
			[
				"PR merge rate (merged / (merged + closed))",
				na(percent(s.prMergeRate)),
			],
			["Mean cost per run", na(`$${s.meanCostUsd.toFixed(4)}`)],
			[
				`Runs with zero human touches (of ${counted.length} counted)`,
				s.noHumanShare === undefined ? "n/a" : percent(s.noHumanShare),
			],
			["Escalations", s.escalated],
			[
				"Runs stopped by budget",
				records.filter((r) => r.status === "stopped").length,
			],
		],
	);

	const recent = records.slice(-RECENT_RUNS).reverse();

	return [
		"# FixLoop dashboard",
		"",
		`Updated ${now.toISOString()}`,
		"",
		"## Summary",
		"",
		summary,
		"",
		`## Last ${RECENT_RUNS} runs`,
		"",
		recent.length
			? table(
					[
						"Issue",
						"Area",
						"Severity",
						"Status",
						"Outcome",
						"Cost",
						"Time to PR",
					],
					recent.map((r) => [
						`#${r.issue}`,
						r.area,
						r.severity,
						r.status,
						r.outcome,
						`$${r.costUsd.toFixed(4)}`,
						minutes(minutesToPr(r)),
					]),
				)
			: "No runs yet.",
		"",
	].join("\n");
}
