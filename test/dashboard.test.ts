import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { metricsCommand } from "../src/cli/metrics.js";
import { localDataStore } from "../src/memory/datastore.js";
import { renderDashboard } from "../src/metrics/dashboard.js";
import { appendRecord, type RunRecord } from "../src/metrics/ledger.js";

const NOW = new Date("2026-10-02T12:00:00.000Z");

const row = (over: Partial<RunRecord> = {}): RunRecord => ({
	runId: "r1",
	issue: 1,
	createdAt: "2026-10-01T00:00:00.000Z",
	reproduced: true,
	fixAttempts: 1,
	models: ["haiku"],
	costUsd: 0.1,
	stageMs: {},
	totalMs: 60_000,
	humanTouches: 0,
	outcome: "open",
	...over,
});

const lines = (md: string) => md.split("\n");

describe("renderDashboard", () => {
	it("has a header, the time, and a summary table for an empty ledger", () => {
		const md = renderDashboard([], NOW);

		expect(md.startsWith("# FixLoop dashboard\n")).toBe(true);
		expect(md).toContain("Updated 2026-10-02T12:00:00.000Z");
		expect(md).toContain("| Runs | 0 |");
		expect(md).toContain("| Median time to PR | n/a |");
		expect(md).toContain("| Reproduction rate | n/a |");
		expect(md).toContain("No runs yet.");
		expect(md).not.toContain("| Issue |");
		expect(md.endsWith("\n")).toBe(true);
	});

	it("fills the summary from the records", () => {
		const md = renderDashboard(
			[
				row({
					prNumber: 1,
					outcome: "merged",
					status: "completed",
					issueCreatedAt: "2026-10-01T09:00:00.000Z",
					prOpenedAt: "2026-10-01T09:30:00.000Z",
					costUsd: 0.2,
					humanTouches: 0,
				}),
				row({
					prNumber: 2,
					outcome: "closed",
					totalMs: 180_000,
					models: ["haiku", "opus"],
					costUsd: 0.4,
					humanTouches: 3,
				}),
				row({
					reproduced: false,
					status: "stopped",
					costUsd: 0,
					humanTouches: null,
				}),
			],
			NOW,
		);

		expect(md).toContain("| Runs | 3 |");
		expect(md).toContain("| Median time to PR | 30.0 min |");
		expect(md).toContain("| Median run time | 2.0 min |");
		expect(md).toContain("| Reproduction rate | 67% |");
		expect(md).toContain(
			"| PR merge rate (merged / (merged + closed)) | 50% |",
		);
		expect(md).toContain("| Mean cost per run | $0.2000 |");
		expect(md).toContain(
			"| Runs with zero human touches (of 2 counted) | 50% |",
		);
		expect(md).toContain("| Escalations | 1 |");
		expect(md).toContain("| Runs stopped by budget | 1 |");
	});

	it("lists the runs, newest first, as table rows", () => {
		const md = renderDashboard(
			[
				row({
					issue: 7,
					area: "backend",
					severity: "S2",
					status: "failed",
					outcome: "closed",
					costUsd: 1.5,
				}),
				row({
					issue: 8,
					area: "frontend",
					severity: "S3",
					status: "completed",
					outcome: "merged",
					costUsd: 0.25,
					issueCreatedAt: "2026-10-01T09:00:00.000Z",
					prOpenedAt: "2026-10-01T09:12:30.000Z",
				}),
			],
			NOW,
		);

		const rows = lines(md).filter((l) => /^\| #\d/.test(l));

		expect(rows).toEqual([
			"| #8 | frontend | S3 | completed | merged | $0.2500 | 12.5 min |",
			"| #7 | backend | S2 | failed | closed | $1.5000 | n/a |",
		]);
		expect(md).toContain(
			"| Issue | Area | Severity | Status | Outcome | Cost | Time to PR |\n| --- | --- | --- | --- | --- | --- | --- |",
		);
	});

	it("shows a dash for fields an old row lacks", () => {
		expect(
			lines(renderDashboard([row({ issue: 3 })], NOW)).find((l) =>
				l.startsWith("| #3"),
			),
		).toBe("| #3 | - | - | - | open | $0.1000 | n/a |");
	});

	it("shows only the 20 most recent runs", () => {
		const records = Array.from({ length: 25 }, (_, i) =>
			row({ issue: i + 1 }),
		);

		const md = renderDashboard(records, NOW);

		const shown = lines(md).filter((l) => /^\| #\d/.test(l));

		expect(shown).toHaveLength(20);
		expect(shown[0]).toMatch(/^\| #25 /);
		expect(shown.at(-1)).toMatch(/^\| #6 /);
		// The summary still counts every run.
		expect(md).toContain("| Runs | 25 |");
	});

	it("cannot be broken out of a table cell by a record field", () => {
		const md = renderDashboard(
			[
				row({
					area: "back|end\n| #99 | evil |" as never,
					status: "done\r\n\r\n# injected" as never,
				}),
			],
			NOW,
		);

		const rows = lines(md).filter((l) => /^\| #\d/.test(l));

		expect(rows).toHaveLength(1);
		// Seven cells: eight pipes, none of them from the field.
		expect(rows[0]?.match(/\|/g)).toHaveLength(8);
		expect(lines(md).some((l) => l.startsWith("# injected"))).toBe(false);
		expect(lines(md).some((l) => l.startsWith("| #99"))).toBe(false);
	});
});

describe("fixloop metrics --markdown", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "fixloop-dash-"));

		vi.spyOn(process, "cwd").mockReturnValue(root);

		await appendRecord(
			localDataStore(root),
			row({ issue: 5, status: "completed" }),
		);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await rm(root, { recursive: true, force: true });
	});

	it("prints the dashboard instead of the text summary", async () => {
		const out = vi.spyOn(console, "log").mockImplementation(() => {});

		expect(await metricsCommand(["--local", "--markdown"])).toBe(0);
		expect(String(out.mock.calls[0]?.[0])).toContain("# FixLoop dashboard");
		expect(String(out.mock.calls[0]?.[0])).toContain("| #5 |");
	});

	it("keeps the text summary as the default", async () => {
		const out = vi.spyOn(console, "log").mockImplementation(() => {});

		expect(await metricsCommand(["--local"])).toBe(0);

		const text = String(out.mock.calls[0]?.[0]);

		expect(text).toContain("runs                1");
		expect(text).toContain("median run time");
		expect(text).not.toContain("# FixLoop dashboard");
	});
});
