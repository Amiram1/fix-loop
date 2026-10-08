import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.js";
import { renderPrBody } from "../src/deliver/prBody.js";
import { evaluateGate } from "../src/gate/gate.js";
import { gateInputFrom } from "../src/gate/input.js";
import type { FixResult } from "../src/pipeline/artifacts.js";
import type { RunContext } from "../src/pipeline/run.js";

const config = parseConfig(
	"app:\n  up: x\n  base_url: http://localhost:3456\ntests:\n  full: go test ./...\nrisk:\n  high_paths: ['pkg/user/**']\n",
);

const fix: FixResult = {
	status: "fixed",
	diff: [
		"diff --git a/pkg/models/task.go b/pkg/models/task.go",
		"--- a/pkg/models/task.go",
		"+++ b/pkg/models/task.go",
		"@@ -10,3 +10,3 @@",
		" keep",
		"-	if due < x {",
		"+	if due <= x {",
		" keep",
		"",
	].join("\n"),
	filesChanged: ["pkg/models/task.go"],
	models: ["claude-sonnet-5-5", "claude-opus-5-5"],
	attempts: 3,
	costUsd: 0.9,
};

const ctxWith = (
	artifacts: Partial<RunContext["artifacts"]> = {},
): RunContext => ({
	runId: "t",
	config,
	issue: {
		number: 12,
		title: "Tasks due today are missing",
		body: "b",
		labels: [],
	},
	dryRun: false,
	artifacts: {
		intake: {
			area: "backend",
			severity: "S3",
			summary: "s",
			injectionSuspected: false,
		},
		reproduction: {
			status: "reproduced",
			area: "backend",
			testPath: "pkg/models/task_test.go",
			testName: "TestDueToday",
			evidence:
				"--- FAIL: TestDueToday (0.00s)\n    task_test.go:44: want 3 tasks, got 2\nFAIL\n",
			attempts: 1,
			costUsd: 0.1,
		},
		fix,
		...artifacts,
	},
});

const render = (ctx: RunContext) =>
	renderPrBody({
		ctx,
		gate: evaluateGate(gateInputFrom(ctx), {
			autonomy: config.autonomy,
			risk: config.risk,
		}),
	});

describe("renderPrBody", () => {
	it("a ready fix", () => {
		expect(render(ctxWith())).toMatchSnapshot();
	});

	it("a risky fix lists the risk reasons once, under Risk notes", () => {
		const body = render(
			ctxWith({
				intake: {
					area: "backend",
					severity: "S1",
					summary: "s",
					injectionSuspected: false,
				},
				fix: { ...fix, filesChanged: ["pkg/user/login.go"] },
			}),
		);

		expect(body).toMatchSnapshot();
		expect(body.match(/The issue is severity S1/g)).toHaveLength(1);
	});

	it("keeps untrusted text from escaping its code span or fence", () => {
		const body = render(
			ctxWith({
				reproduction: {
					status: "reproduced",
					area: "backend",
					testPath: "a_test.go",
					testName: "Test`Evil`",
					evidence: "boom\n```\n## Injected heading @everyone\n```\n",
					attempts: 1,
					costUsd: 0,
				},
			}),
		);

		expect(body).toContain(
			"````\nboom\n```\n## Injected heading @everyone\n```\n````",
		);
		expect(body).toContain("`Test'Evil'`");
	});

	it("shows only the tail of a long output", () => {
		const evidence = `${"x".repeat(5000)}THE END`;

		const body = render(
			ctxWith({
				reproduction: {
					status: "reproduced",
					area: "backend",
					testPath: "a_test.go",
					testName: "T",
					evidence,
					attempts: 1,
					costUsd: 0,
				},
			}),
		);

		expect(body).toContain("THE END");
		expect(body).not.toContain("x".repeat(3001));
	});

	it("still renders when artifacts are missing", () => {
		const body = render(
			ctxWith({ reproduction: undefined, intake: undefined }),
		);

		expect(body).toContain("no test output was recorded");
		expect(body).toContain("none recorded");
	});
});
