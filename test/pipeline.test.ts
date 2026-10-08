import { describe, expect, it, vi } from "vitest";
import { withDevModels } from "../src/config/dev.js";
import { parseConfig } from "../src/config/load.js";
import {
	type RunContext,
	runPipeline,
	type Stage,
} from "../src/pipeline/run.js";
import type { StatusView } from "../src/ui/statusComment.js";

const config = parseConfig(`
app:
  up: x
  base_url: http://localhost:3456
tests:
  full: make test
`);

const ctx: RunContext = {
	runId: "test",
	config,
	issue: { number: 1, title: "t", body: "", labels: [] },
	dryRun: true,
};

function recorder() {
	const views: StatusView[] = [];

	return {
		views,
		reporter: {
			publish: async (v: StatusView) =>
				void views.push(structuredClone(v)),
		},
	};
}

const ok = (name: string): Stage => ({
	name,
	run: async () => ({ state: "done" }),
});

describe("runPipeline", () => {
	it("runs stages in order and reports the final state", async () => {
		const { views, reporter } = recorder();

		const result = await runPipeline(ctx, [ok("A"), ok("B")], reporter);

		expect(result).toMatchObject({ ok: true });
		expect(views.at(-1)?.headline).toBe("finished");
		expect(views.at(-1)?.stages.map((s) => s.state)).toEqual([
			"done",
			"done",
		]);
	});

	it("stops at the first throwing stage and marks the rest pending", async () => {
		const { views, reporter } = recorder();

		const boom: Stage = {
			name: "B",
			run: async () => {
				throw new Error("kaboom");
			},
		};

		const result = await runPipeline(
			ctx,
			[ok("A"), boom, ok("C")],
			reporter,
		);

		expect(result).toMatchObject({ ok: false, failedStage: "B" });

		const last = views.at(-1);

		expect(last?.headline).toBe("failed at B");
		expect(last?.stages.map((s) => s.state)).toEqual([
			"done",
			"failed",
			"pending",
		]);
		expect(last?.stages[1]?.detail).toBe("kaboom");
	});

	it("runs only the selected stage and marks the others not selected", async () => {
		const { views, reporter } = recorder();

		let ran = 0;

		const counted = (name: string): Stage => ({
			name,
			run: async () => {
				ran++;
				return { state: "done" };
			},
		});

		await runPipeline(ctx, [counted("A"), counted("B")], reporter, "B");

		expect(ran).toBe(1);
		expect(views.at(-1)?.stages[0]).toMatchObject({
			state: "skipped",
			detail: "not selected",
		});
	});

	it("rejects an unknown stage name", async () => {
		const { reporter } = recorder();

		await expect(
			runPipeline(ctx, [ok("A")], reporter, "Nope"),
		).rejects.toThrow(/Known stages: A/);
	});

	it("placeholder stages report as skipped, so an empty run is visibly not real work", async () => {
		const { views, reporter } = recorder();

		const placeholders = ["A", "B"].map((name) => ({
			name,
			run: async () => ({
				state: "skipped" as const,
				detail: "not implemented yet",
			}),
		}));

		await runPipeline(ctx, placeholders, reporter);

		expect(views.at(-1)?.stages.every((s) => s.state === "skipped")).toBe(
			true,
		);
	});
});

describe("withDevModels", () => {
	it("forces every model to Haiku without touching other config", () => {
		const dev = withDevModels(config);

		expect(dev.models).toEqual({
			triage: "claude-haiku-5-5",
			fix: "claude-haiku-5-5",
			escalate: "claude-haiku-5-5",
		});
		expect(dev.app).toEqual(config.app);
		expect(dev.effort).toEqual({
			triage: "low",
			reproduce: "low",
			fix: "low",
			escalate: "low",
		});
		expect(dev.effort).toEqual({
			triage: "low",
			reproduce: "low",
			fix: "low",
			escalate: "low",
		});
	});
});

describe("halting", () => {
	it("stops cleanly on a halt outcome and does not run later stages", async () => {
		const { reporter } = recorder();

		const later = vi.fn(async () => ({ state: "done" as const }));

		const halting: Stage = {
			name: "A",
			run: async () => ({ state: "halt", detail: "no bug" }),
		};

		const result = await runPipeline(
			ctx,
			[halting, { name: "B", run: later }],
			reporter,
		);

		expect(result).toMatchObject({ ok: true, haltedAt: "A" });
		expect(later).not.toHaveBeenCalled();
	});
});

describe("the run result", () => {
	const boom: Stage = {
		name: "B",
		run: async () => {
			throw new Error("kaboom");
		},
	};

	it("records when the run started and how every stage ended", async () => {
		const before = Date.now();

		const result = await runPipeline(
			ctx,
			[
				ok("A"),
				{
					name: "B",
					run: async () => ({ state: "skipped", detail: "n/a" }),
				},
			],
			recorder().reporter,
		);

		expect(Date.parse(result.startedAt)).toBeGreaterThanOrEqual(before);
		expect(Date.parse(result.startedAt)).toBeLessThanOrEqual(Date.now());
		expect(result.stages).toEqual([
			{ name: "A", state: "done", detail: undefined },
			{ name: "B", state: "skipped", detail: "n/a" },
		]);
	});

	it("keeps the failing stage's message and leaves later stages pending", async () => {
		const result = await runPipeline(
			ctx,
			[ok("A"), boom, ok("C")],
			recorder().reporter,
		);

		expect(result.stages.map((s) => s.state)).toEqual([
			"done",
			"failed",
			"pending",
		]);
		expect(result.stages[1]?.detail).toBe("kaboom");
	});

	it("marks the stages after a halt as skipped", async () => {
		const result = await runPipeline(
			ctx,
			[
				{
					name: "A",
					run: async () => ({ state: "halt", detail: "no bug" }),
				},
				ok("B"),
			],
			recorder().reporter,
		);

		expect(result.stages).toEqual([
			{ name: "A", state: "halted", detail: "no bug" },
			{ name: "B", state: "skipped", detail: "not run" },
		]);
	});

	it("is the same as the last status published", async () => {
		const { views, reporter } = recorder();

		const result = await runPipeline(ctx, [ok("A"), boom], reporter);

		expect(result.stages).toEqual(views.at(-1)?.stages);
	});
});
