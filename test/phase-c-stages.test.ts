import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.js";
import type { GateResult, Reproduction } from "../src/pipeline/artifacts.js";
import { makeDeliverStage } from "../src/pipeline/deliver.js";
import { makeGateStage } from "../src/pipeline/gate.js";
import { makeNotifyStage } from "../src/pipeline/notify.js";
import type { RunContext } from "../src/pipeline/run.js";

const config = parseConfig(
	"app:\n  up: x\n  base_url: http://localhost:3456\ntests:\n  full: 'true'\n",
);

function ctxWith(artifacts: RunContext["artifacts"]): RunContext {
	return {
		runId: "t",
		config,
		issue: { number: 3, title: "Tasks vanish", body: "they disappear" },
		dryRun: true,
		artifacts,
	};
}

const notReproduced: Reproduction = {
	status: "not_reproduced",
	area: "backend",
	reason: "the agent ended without finishing a RED test",
	attempts: 2,
	costUsd: 0.01,
};

const reproduced: Reproduction = {
	status: "reproduced",
	area: "backend",
	testPath: "pkg/x_test.go",
	testName: "TestReproX",
	evidence: "--- FAIL: TestReproX",
	attempts: 1,
	costUsd: 0.01,
};

const diagnosis: GateResult = {
	delivery: "diagnosis_only",
	confidence: 0.45,
	risky: false,
	reasons: ["the target test is not green"],
};

describe("gate stage", () => {
	it("records the gate decision on the run", async () => {
		const ctx = ctxWith({ reproduction: notReproduced });

		const outcome = await makeGateStage().run(ctx);

		expect(ctx.artifacts.gate?.delivery).toBe("diagnosis_only");
		expect(outcome.state).toBe("done");
		expect(outcome.detail).toMatch(/^diagnosis_only/);
	});
});

describe("notify stage", () => {
	it("asks the reporter a question when the bug was not reproduced, and posts nothing in a dry run", async () => {
		const ctx = ctxWith({ reproduction: notReproduced });

		const outcome = await makeNotifyStage({ dryRun: true }).run(ctx);

		expect(outcome.state).toBe("done");
		expect(ctx.artifacts.delivery?.status).toBe("dry_run");
		expect(ctx.artifacts.delivery?.detail).toContain(
			"needs more information",
		);
	});

	it("posts the diagnosis for a reproduced bug with a diagnosis-only gate", async () => {
		const ctx = ctxWith({ reproduction: reproduced, gate: diagnosis });

		await makeNotifyStage({ dryRun: true }).run(ctx);

		expect(ctx.artifacts.delivery?.status).toBe("dry_run");
		expect(ctx.artifacts.delivery?.detail).toContain("no pull request");
	});

	it("does nothing when a pull request is the outcome", async () => {
		const ctx = ctxWith({
			reproduction: reproduced,
			gate: { ...diagnosis, delivery: "draft_pr", confidence: 0.6 },
		});

		const outcome = await makeNotifyStage({ dryRun: true }).run(ctx);

		expect(outcome.state).toBe("skipped");
		expect(ctx.artifacts.delivery).toBeUndefined();
	});
});

describe("deliver stage", () => {
	it("is skipped for a diagnosis, leaving the diagnosis to Notify", async () => {
		const ctx = ctxWith({ reproduction: reproduced, gate: diagnosis });

		const outcome = await makeDeliverStage({
			root: "/tmp",
			headSha: "abc",
			dryRun: true,
		}).run(ctx);

		expect(outcome.state).toBe("skipped");
		expect(ctx.artifacts.delivery?.status).toBe("skipped");
	});

	it("is skipped when there is no gate result", async () => {
		const ctx = ctxWith({ reproduction: reproduced });

		const outcome = await makeDeliverStage({
			root: "/tmp",
			headSha: "abc",
			dryRun: true,
		}).run(ctx);

		expect(outcome).toMatchObject({
			state: "skipped",
			detail: "no gate result",
		});
	});
});

describe("unknown area and the reporter", () => {
	it("asks the reporter about the area when the area is unknown and nothing was reproduced", async () => {
		const ctx = ctxWith({
			intake: {
				area: "unknown",
				severity: "S3",
				summary: "s",
				injectionSuspected: false,
			},
		});

		const outcome = await makeNotifyStage({ dryRun: true }).run(ctx);

		expect(outcome.state).toBe("done");
		expect(ctx.artifacts.delivery?.detail).toContain(
			"needs more information",
		);
		expect(ctx.artifacts.delivery?.detail).toMatch(
			/UI|API|screen|endpoint/i,
		);
	});
});
