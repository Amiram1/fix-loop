import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetExceeded, BudgetTracker } from "../src/agent/budget.js";
import type { MessagesApi } from "../src/agent/client.js";
import { fixBug } from "../src/fix/loop.js";
import type { AreaRunner, RunContext, TestRun } from "../src/repro/runner.js";

const exec = promisify(execFile);

const TEST = "tests/repro.spec";

const FIXED = "ok\n";

const toolUse = (id: string, name: string, input: unknown) =>
	({
		content: [{ type: "tool_use", id, name, input }],
		stop_reason: "tool_use",
		usage: { input_tokens: 10, output_tokens: 5 },
	}) as unknown as Anthropic.Message;

const endTurn = (text: string) =>
	({
		content: [{ type: "text", text }],
		stop_reason: "end_turn",
		usage: { input_tokens: 10, output_tokens: 5 },
	}) as unknown as Anthropic.Message;

function scripted(responses: Anthropic.Message[]) {
	const create = vi.fn<MessagesApi["create"]>();

	for (const r of responses) create.mockResolvedValueOnce(r);
	return { create, client: { create } as MessagesApi };
}

/** A "bug" is a file that must read exactly "ok\n". The red test checks it; the full suite checks it too. */
function fakeRunner(): AreaRunner {
	return {
		area: "backend",
		testGlobs: ["tests/*.spec"],
		hints: "",
		runTest: vi.fn(async (_test, ctx: RunContext): Promise<TestRun> => {
			const value = await readFile(
				join(ctx.checkout, "src/value.txt"),
				"utf8",
			);

			return value === FIXED
				? { exitCode: 0, output: "PASS" }
				: { exitCode: 1, output: "FAIL TestRepro: expected ok" };
		}),
		classify: () => ({ red: true, reason: "assertion" }),
	};
}

describe("fixBug", () => {
	let checkout: string;

	let context: RunContext;

	beforeEach(async () => {
		checkout = await mkdtemp(join(tmpdir(), "fixloop-fix-test-"));
		await exec("git", ["init", "-q"], { cwd: checkout });
		await mkdir(join(checkout, "src"), { recursive: true });
		await writeFile(join(checkout, "src/value.txt"), "bad\n");
		await exec("git", ["add", "."], { cwd: checkout });
		await exec(
			"git",
			[
				"-c",
				"user.name=t",
				"-c",
				"user.email=t@t",
				"commit",
				"-qm",
				"init",
			],
			{ cwd: checkout },
		);
		await mkdir(join(checkout, "tests"), { recursive: true });
		await writeFile(join(checkout, TEST), "red test\n");
		context = { checkout, env: {} };
	});

	afterEach(async () => {
		await rm(checkout, { recursive: true, force: true });
	});

	const base = (
		client: MessagesApi,
		runner = fakeRunner(),
		overrides: Partial<Parameters<typeof fixBug>[0]> = {},
	) => ({
		client,
		budget: new BudgetTracker(5),
		runner,
		context,
		red: { testPath: TEST, testName: "TestRepro" },
		issue: { title: "value is wrong", body: "it should read ok" },
		fullCommand: "true",
		fixModel: "claude-sonnet-5-5",
		escalateModel: "claude-opus-5-5",
		maxAttempts: 4,
		maxTurns: 10,
		runFull: vi.fn(async (ck: string): Promise<TestRun> => {
			const value = await readFile(join(ck, "src/value.txt"), "utf8");

			return value === FIXED
				? { exitCode: 0, output: "suite ok" }
				: { exitCode: 1, output: "suite FAIL" };
		}),
		...overrides,
	});

	it("accepts a fix made in the first phase, once the target and full suite pass", async () => {
		const { client } = scripted([
			toolUse("1", "edit_file", {
				path: "src/value.txt",
				old_string: "bad\n",
				new_string: "ok\n",
			}),
			toolUse("2", "run_target_test", {}),
			toolUse("3", "finish_fix", { summary: "fixed" }),
		]);

		const result = await fixBug(base(client));

		expect(result).toMatchObject({
			status: "fixed",
			filesChanged: ["src/value.txt"],
			models: ["claude-sonnet-5-5"],
			attempts: 1,
		});
		expect(result.diff).toContain("+ok");
		expect(result.diff).not.toContain("red test");
	});

	it("escalates to the escalation model after two rejected finishes, and then fixes", async () => {
		const { create, client } = scripted([
			toolUse("1", "finish_fix", { summary: "done" }),
			toolUse("2", "finish_fix", { summary: "done" }),
			toolUse("3", "edit_file", {
				path: "src/value.txt",
				old_string: "bad\n",
				new_string: "ok\n",
			}),
			toolUse("4", "finish_fix", { summary: "done" }),
		]);

		const result = await fixBug(base(client));

		expect(result).toMatchObject({
			status: "fixed",
			models: ["claude-sonnet-5-5", "claude-opus-5-5"],
			attempts: 3,
		});
		expect(create.mock.calls[2]?.[0].model).toBe("claude-opus-5-5");
	});

	it("refuses to edit a test file, and reports not fixed when the agent gives up", async () => {
		const { client } = scripted([
			toolUse("1", "edit_file", {
				path: TEST,
				old_string: "red",
				new_string: "green",
			}),
			endTurn("I could not change it"),
			endTurn("still nothing"),
		]);

		const result = await fixBug(base(client));

		expect(result.status).toBe("not_fixed");
		expect(await readFile(join(checkout, TEST), "utf8")).toBe("red test\n");
	});

	it("refuses an edit whose old_string is not unique, so nothing is guessed", async () => {
		await writeFile(join(checkout, "src/value.txt"), "bad\nbad\n");

		const { create, client } = scripted([
			toolUse("1", "edit_file", {
				path: "src/value.txt",
				old_string: "bad\n",
				new_string: "ok\n",
			}),
			endTurn("gave up"),
			endTurn("gave up"),
		]);

		await fixBug(base(client));

		const toolResult = create.mock.calls[1]?.[0].messages.at(-1) as {
			content: Array<{ is_error?: boolean; content: string }>;
		};

		expect(toolResult.content[0]).toMatchObject({ is_error: true });
		expect(toolResult.content[0]?.content).toMatch(/occurs 2 times/);
	});

	it("does not accept a finish while the full suite fails", async () => {
		const { client } = scripted([
			toolUse("1", "edit_file", {
				path: "src/value.txt",
				old_string: "bad\n",
				new_string: "ok\n",
			}),
			toolUse("2", "finish_fix", { summary: "done" }),
			endTurn("stop"),
			endTurn("stop"),
		]);

		const runFull = vi.fn(
			async (): Promise<TestRun> => ({
				exitCode: 1,
				output: "suite FAIL",
			}),
		);

		const result = await fixBug(
			base(client, fakeRunner(), { runFull, maxAttempts: 1 }),
		);

		expect(result.status).toBe("not_fixed");
		expect(result.reason).toMatch(/full suite fails/);
		expect(runFull).toHaveBeenCalled();
	});

	it("keeps the file a path outside the checkout", async () => {
		const { create, client } = scripted([
			toolUse("1", "create_file", {
				path: "../escape.txt",
				content: "x",
			}),
			endTurn("gave up"),
			endTurn("gave up"),
		]);

		await fixBug(base(client));

		const toolResult = create.mock.calls[1]?.[0].messages.at(-1) as {
			content: Array<{ is_error?: boolean }>;
		};

		expect(toolResult.content[0]).toMatchObject({ is_error: true });
	});

	it("lets a spent budget fail the run instead of reporting not fixed", async () => {
		const budget = new BudgetTracker(0.01);

		budget.record(0.02);

		const { client } = scripted([]);

		await expect(
			fixBug(base(client, fakeRunner(), { budget })),
		).rejects.toBeInstanceOf(BudgetExceeded);
	});
});
