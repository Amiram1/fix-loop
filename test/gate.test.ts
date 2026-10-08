import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.js";
import { evaluateGate, WEIGHTS } from "../src/gate/gate.js";
import {
	countDiffLines,
	type GateInput,
	gateInputFrom,
} from "../src/gate/input.js";
import type { FixResult } from "../src/pipeline/artifacts.js";
import type { RunContext } from "../src/pipeline/run.js";

const config = parseConfig(
	"app:\n  up: x\n  base_url: http://localhost:3456\ntests:\n  full: 'true'\nrisk:\n  high_paths: ['pkg/user/**', 'pkg/models/auth*', 'src/auth/']\n  max_diff_lines: 150\n",
);

const gate = (input: Partial<GateInput>, autonomy = config.autonomy) =>
	evaluateGate(
		{
			reproduced: true,
			targetGreen: true,
			suiteGreen: true,
			diffLines: 20,
			filesChanged: ["pkg/web/handler.go"],
			severity: "S3",
			...input,
		},
		{ autonomy, risk: config.risk },
	);

describe("confidence weights", () => {
	it("renormalises the plan's four weights (sum 0.9, no self-assessment term) to sum to 1", () => {
		const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);

		expect(sum).toBe(90);
		expect(gate({}).confidence).toBe(1);
	});

	it.each([
		["reproduced", { reproduced: true }, 35],
		["targetGreen", { targetGreen: true }, 25],
		["suiteGreen", { suiteGreen: true }, 20],
		["withinSizeLimit", { diffLines: 0 }, 10],
	] as const)("%s alone is its weight over 0.9", (_name, only, weight) => {
		const nothing = {
			reproduced: false,
			targetGreen: false,
			suiteGreen: false,
			diffLines: 1000,
		};

		expect(gate({ ...nothing, ...only }).confidence).toBe(weight / 90);
	});

	it("is 0 when nothing passes and the diff is over the limit", () => {
		expect(
			gate({
				reproduced: false,
				targetGreen: false,
				suiteGreen: false,
				diffLines: 151,
			}).confidence,
		).toBe(0);
	});
});

describe("decision table", () => {
	it("ready_pr when confident and not risky", () => {
		const result = gate({});

		expect(result).toMatchObject({
			delivery: "ready_pr",
			confidence: 1,
			risky: false,
		});
		expect(result.reasons.at(-1)).toContain("ready for review");
	});

	it("draft_pr when confidence is between the thresholds", () => {
		// reproduced + target + size limit = 70/90
		const result = gate({ suiteGreen: false });

		expect(result.delivery).toBe("draft_pr");
		expect(result.risky).toBe(false);
	});

	it("diagnosis_only below the draft threshold", () => {
		const result = gate({
			reproduced: false,
			targetGreen: false,
			suiteGreen: false,
		});

		expect(result.delivery).toBe("diagnosis_only");
		expect(result.reasons.at(-1)).toContain("no PR");
	});

	it("never ready_pr when risky, even at full confidence", () => {
		const result = gate({ severity: "S1" });

		expect(result.confidence).toBe(1);
		expect(result).toMatchObject({ delivery: "draft_pr", risky: true });
	});

	it("risky and low confidence is still diagnosis_only", () => {
		const result = gate({
			severity: "S1",
			reproduced: false,
			targetGreen: false,
			suiteGreen: false,
		});

		expect(result).toMatchObject({
			delivery: "diagnosis_only",
			risky: true,
		});
	});
});

describe("thresholds are inclusive", () => {
	// Not risky means within the size limit, so these are 10 + a subset of 35, 25, 20.
	const reproducedAndTarget = {
		suiteGreen: false,
	};

	const at = 70 / 90;

	it("ready_pr exactly at the ready threshold", () => {
		const autonomy = {
			ready_pr_min_confidence: at,
			draft_pr_min_confidence: 0.5,
		};

		expect(gate(reproducedAndTarget, autonomy).delivery).toBe("ready_pr");
	});

	it("draft_pr just under the ready threshold", () => {
		const autonomy = {
			ready_pr_min_confidence: at + 1e-9,
			draft_pr_min_confidence: 0.5,
		};

		expect(gate(reproducedAndTarget, autonomy).delivery).toBe("draft_pr");
	});

	it("draft_pr exactly at the default draft threshold of 0.5", () => {
		// target + suite = 45/90, with the diff over the limit.
		const exactlyHalf = gate({
			reproduced: false,
			diffLines: 151,
		});

		expect(exactlyHalf.confidence).toBe(0.5);
		expect(exactlyHalf.delivery).toBe("draft_pr");

		// reproduced + size limit = 45/90 as well.
		const alsoHalf = gate({
			targetGreen: false,
			suiteGreen: false,
		});

		expect(alsoHalf.confidence).toBe(0.5);
		expect(alsoHalf.delivery).toBe("draft_pr");
	});

	it("diagnosis_only just over the draft threshold", () => {
		const result = gate(
			{ targetGreen: false, suiteGreen: false },
			{
				ready_pr_min_confidence: 0.8,
				draft_pr_min_confidence: 0.5 + 1e-9,
			},
		);

		expect(result.delivery).toBe("diagnosis_only");
	});

	it("with the default thresholds, 0.78 is a draft and only a green suite reaches ready", () => {
		expect(gate({ suiteGreen: false }).confidence).toBeCloseTo(0.7778, 4);
		expect(gate({ suiteGreen: false }).delivery).toBe("draft_pr");
		expect(gate({}).delivery).toBe("ready_pr");
	});
});

describe("risk rules", () => {
	it.each([
		["pkg/user/service.go", "a ** glob"],
		["pkg/user/deep/nested/file.go", "a ** glob, nested"],
		["pkg/models/auth_token.go", "a * glob"],
		["src/auth/login.ts", "a directory glob ending in /"],
	])("%s (%s) is risky", (file) => {
		const result = gate({ filesChanged: ["pkg/web/ok.go", file] });

		expect(result.risky).toBe(true);
		expect(result.delivery).toBe("draft_pr");
		expect(result.reasons.join("\n")).toContain(file);
	});

	it.each([
		"pkg/users/service.go",
		"pkg/models/task.go",
		"src/authors/list.ts",
		"vendor/pkg/user/x.go",
	])("%s is not risky", (file) => {
		expect(gate({ filesChanged: [file] }).risky).toBe(false);
	});

	it("S1 is risky and the other severities are not", () => {
		expect(gate({ severity: "S1" }).risky).toBe(true);

		for (const severity of ["S2", "S3", "S4"] as const) {
			expect(gate({ severity }).risky).toBe(false);
		}
	});

	it("a diff over max_diff_lines is risky and costs the size weight; exactly at the limit is not", () => {
		const at = gate({ diffLines: 150 });

		const over = gate({ diffLines: 151 });

		expect(at).toMatchObject({ risky: false, confidence: 1 });
		expect(over.risky).toBe(true);
		expect(over.confidence).toBe(80 / 90);
		expect(over.delivery).toBe("draft_pr");
		expect(over.reasons.join("\n")).toContain("over the limit of 150");
	});

	it("no high_paths configured means no path risk", () => {
		const result = evaluateGate(
			{
				reproduced: true,
				targetGreen: true,
				suiteGreen: true,
				diffLines: 1,
				filesChanged: ["pkg/user/x.go"],
				severity: "S2",
			},
			{
				autonomy: config.autonomy,
				risk: { high_paths: [], max_diff_lines: 150 },
			},
		);

		expect(result.delivery).toBe("ready_pr");
	});
});

describe("determinism", () => {
	it("gives the same result for the same input", () => {
		expect(gate({ suiteGreen: false })).toEqual(
			gate({ suiteGreen: false }),
		);
	});
});

describe("countDiffLines", () => {
	const diff = [
		"diff --git a/a.sql b/a.sql",
		"index 111..222 100644",
		"--- a/a.sql",
		"+++ b/a.sql",
		"@@ -1,3 +1,3 @@",
		" keep",
		"--- a comment that was removed",
		"+-- a comment that was added",
		"\\ No newline at end of file",
		"diff --git a/b.txt b/b.txt",
		"new file mode 100644",
		"--- /dev/null",
		"+++ b/b.txt",
		"@@ -0,0 +1,2 @@",
		"+one",
		"+two",
		"",
	].join("\n");

	it("counts changed lines and skips file headers", () => {
		expect(countDiffLines(diff)).toBe(4);
	});

	it("is 0 for an empty diff", () => {
		expect(countDiffLines("")).toBe(0);
	});
});

describe("gateInputFrom", () => {
	const fixed: FixResult = {
		status: "fixed",
		diff: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
		filesChanged: ["x"],
		models: ["m"],
		attempts: 1,
		costUsd: 0,
	};

	const ctx = (artifacts: RunContext["artifacts"]): RunContext => ({
		runId: "t",
		config,
		issue: { number: 1, title: "t", body: "b", labels: [] },
		dryRun: true,
		artifacts,
	});

	it("reads the signals from the artifacts", () => {
		expect(
			gateInputFrom(
				ctx({
					intake: {
						area: "backend",
						severity: "S3",
						summary: "s",
						injectionSuspected: false,
					},
					reproduction: {
						status: "reproduced",
						area: "backend",
						attempts: 1,
						costUsd: 0,
					},
					fix: fixed,
				}),
			),
		).toEqual({
			reproduced: true,
			targetGreen: true,
			suiteGreen: true,
			diffLines: 2,
			filesChanged: ["x"],
			severity: "S3",
		});
	});

	it("a fix that is not fixed has neither green signal", () => {
		const input = gateInputFrom(
			ctx({ fix: { ...fixed, status: "not_fixed" } }),
		);

		expect(input).toMatchObject({ targetGreen: false, suiteGreen: false });
	});

	it("uses the conservative value for every missing artifact", () => {
		const input = gateInputFrom(ctx({}));

		expect(input).toEqual({
			reproduced: false,
			targetGreen: false,
			suiteGreen: false,
			diffLines: 0,
			filesChanged: [],
			severity: "S1",
		});
		expect(gate(input).delivery).toBe("diagnosis_only");
	});

	it("a not-reproduced run is not reproduced", () => {
		const input = gateInputFrom(
			ctx({
				reproduction: {
					status: "not_reproduced",
					area: "backend",
					attempts: 3,
					costUsd: 0,
				},
			}),
		);

		expect(input.reproduced).toBe(false);
	});
});
