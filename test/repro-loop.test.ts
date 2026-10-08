import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetTracker } from "../src/agent/budget.js";
import type { MessagesApi } from "../src/agent/client.js";
import { reproduce } from "../src/repro/loop.js";
import type { AreaRunner, RunContext } from "../src/repro/runner.js";

const TEST_FILE = "pkg/utils/zz_repro_test.go";

function toolUse(id: string, name: string, input: unknown): Anthropic.Message {
	return {
		content: [{ type: "tool_use", id, name, input }],
		stop_reason: "tool_use",
		usage: { input_tokens: 10, output_tokens: 5 },
	} as unknown as Anthropic.Message;
}

function endTurn(text: string): Anthropic.Message {
	return {
		content: [{ type: "text", text }],
		stop_reason: "end_turn",
		usage: { input_tokens: 10, output_tokens: 5 },
	} as unknown as Anthropic.Message;
}

function scripted(responses: Anthropic.Message[]) {
	const create = vi.fn<MessagesApi["create"]>();

	for (const r of responses) create.mockResolvedValueOnce(r);
	return { create };
}

function fakeRunner(
	output = "--- FAIL: TestRepro\n    expected 1 got 2",
): AreaRunner {
	return {
		area: "backend",
		testGlob: "pkg/**/*_test.go",
		hints: "Go tests.",
		runTest: vi.fn(async () => ({ exitCode: 1, output })),
		classify: (run) => ({
			red: run.exitCode !== 0 && run.output.includes("--- FAIL"),
			reason: "assertion failed",
		}),
	};
}

describe("reproduce loop", () => {
	let checkout: string;

	let context: RunContext;

	beforeEach(async () => {
		checkout = await mkdtemp(join(tmpdir(), "fixloop-loop-test-"));
		context = { checkout, env: {} };
		await mkdir(join(checkout, "pkg/utils"), { recursive: true });
		await writeFile(
			join(checkout, "pkg/utils/existing.go"),
			"package utils\n",
		);
	});

	afterEach(async () => {
		await rm(checkout, { recursive: true, force: true });
	});

	const base = (
		client: MessagesApi,
		runner: AreaRunner,
		budget = new BudgetTracker(1),
	) => ({
		client,
		model: "claude-sonnet-5-5",
		budget,
		runner,
		context,
		issue: {
			title: "NotIn drops items",
			body: "Repro: NotIn([9],[1,9]) returns [9]",
		},
		maxTurns: 10,
	});

	it("reproduces when the agent writes a test, sees it go red, and finishes it", async () => {
		const client = scripted([
			toolUse("w", "write_test_file", {
				path: TEST_FILE,
				content: "package utils\n",
			}),
			toolUse("r", "run_test", { file: TEST_FILE, name: "TestRepro" }),
			toolUse("f", "finish_reproduction", {
				file: TEST_FILE,
				name: "TestRepro",
			}),
			endTurn("done"),
		]);

		const result = await reproduce(base(client, fakeRunner()));

		expect(result).toMatchObject({
			status: "reproduced",
			area: "backend",
			testPath: TEST_FILE,
			testName: "TestRepro",
			attempts: 1,
		});
		expect(result.evidence).toContain("--- FAIL");
		expect(await readFile(join(checkout, TEST_FILE), "utf8")).toBe(
			"package utils\n",
		);
	});

	it("does not accept finish when the latest run was green", async () => {
		const runner = fakeRunner("ok");

		runner.classify = () => ({ red: false, reason: "passed" });

		const client = scripted([
			toolUse("w", "write_test_file", { path: TEST_FILE, content: "x" }),
			toolUse("r", "run_test", { file: TEST_FILE, name: "TestRepro" }),
			toolUse("f", "finish_reproduction", {
				file: TEST_FILE,
				name: "TestRepro",
			}),
			endTurn("gave up"),
		]);

		const result = await reproduce(base(client, runner));

		expect(result.status).toBe("not_reproduced");
		expect(runner.runTest).toHaveBeenCalledTimes(1);
	});

	it("refuses to write outside the test glob or over an existing file", async () => {
		const client = scripted([
			toolUse("a", "write_test_file", {
				path: "pkg/utils/existing.go",
				content: "x",
			}),
			toolUse("b", "write_test_file", {
				path: "../escape_test.go",
				content: "x",
			}),
			toolUse("c", "write_test_file", {
				path: "frontend/x_test.go",
				content: "x",
			}),
			endTurn("nothing written"),
		]);

		const result = await reproduce(base(client, fakeRunner()));

		expect(result.status).toBe("not_reproduced");
		expect(
			await readFile(join(checkout, "pkg/utils/existing.go"), "utf8"),
		).toBe("package utils\n");
	});

	it("never passes a model-chosen name to the runner when it has shell characters", async () => {
		const runner = fakeRunner();

		const client = scripted([
			toolUse("w", "write_test_file", { path: TEST_FILE, content: "x" }),
			toolUse("r", "run_test", {
				file: TEST_FILE,
				name: "TestA; rm -rf /",
			}),
			endTurn("done"),
		]);

		const result = await reproduce(base(client, runner));

		expect(result.status).toBe("not_reproduced");
		expect(runner.runTest).not.toHaveBeenCalled();
	});

	it("reports an unfinished attempt as not reproduced instead of throwing", async () => {
		const client = scripted([endTurn("I could not find the bug")]);

		const result = await reproduce(base(client, fakeRunner()));

		expect(result).toMatchObject({
			status: "not_reproduced",
			area: "backend",
		});
		expect(result.reason).toMatch(/without finishing/);
	});

	it("lets a spent budget fail the run rather than hiding it as a missed reproduction", async () => {
		const budget = new BudgetTracker(0.01);

		budget.record(0.02);

		const client = scripted([]);

		await expect(
			reproduce(base(client, fakeRunner(), budget)),
		).rejects.toThrow(/run budget/);
	});
});
