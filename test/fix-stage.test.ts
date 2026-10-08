import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetTracker } from "../src/agent/budget.js";
import type { MessagesApi } from "../src/agent/client.js";
import { parseConfig } from "../src/config/load.js";
import { collectDiff } from "../src/fix/git.js";
import { makeFixStage } from "../src/pipeline/fix.js";
import type { RunContext } from "../src/pipeline/run.js";
import type { AreaRunner, TestRun } from "../src/repro/runner.js";

const exec = promisify(execFile);

const TEST = "tests/repro.spec";

const config = (full: string) =>
	parseConfig(
		`app:\n  up: x\n  base_url: http://localhost:3456\ntests:\n  full: ${JSON.stringify(full)}\n`,
	);

const toolUse = (id: string, name: string, input: unknown) =>
	({
		content: [{ type: "tool_use", id, name, input }],
		stop_reason: "tool_use",
		usage: { input_tokens: 10, output_tokens: 5 },
	}) as unknown as Anthropic.Message;

const runner: AreaRunner = {
	area: "backend",
	testGlobs: ["tests/*.spec"],
	hints: "",
	runTest: vi.fn(async (_t, ctx): Promise<TestRun> => {
		const value = await readFile(
			join(ctx.checkout, "src/value.txt"),
			"utf8",
		);

		return value === "ok\n"
			? { exitCode: 0, output: "PASS" }
			: { exitCode: 1, output: "FAIL TestRepro" };
	}),
	classify: () => ({ red: true, reason: "assertion" }),
};

function ctxWith(
	fullCommand: string,
	reproduction: RunContext["artifacts"]["reproduction"],
): RunContext {
	return {
		runId: "t",
		config: config(fullCommand),
		issue: {
			number: 1,
			title: "value is wrong",
			body: "it should read ok",
		},
		dryRun: true,
		artifacts: { reproduction },
	};
}

const red = {
	status: "reproduced" as const,
	area: "backend" as const,
	testPath: TEST,
	testName: "TestRepro",
	testContent: "red test\n",
	attempts: 1,
	costUsd: 0,
};

describe("makeFixStage", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "fixloop-fix-stage-"));
		await exec("git", ["init", "-q"], { cwd: root });
		await mkdir(join(root, "src"), { recursive: true });
		await writeFile(join(root, "src/value.txt"), "bad\n");
		await exec("git", ["add", "."], { cwd: root });
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
			{ cwd: root },
		);
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	const stage = (client: MessagesApi, budget = new BudgetTracker(5)) =>
		makeFixStage({
			client,
			budget,
			root,
			headSha: "HEAD",
			runners: { backend: runner },
		});

	it("halts without calling the model when there is no red test", async () => {
		const create = vi.fn();

		const outcome = await stage({ create } as unknown as MessagesApi).run(
			ctxWith("true", undefined),
		);

		expect(outcome).toMatchObject({
			state: "halt",
			detail: "no red test to fix against",
		});
		expect(create).not.toHaveBeenCalled();
	});

	it("halts when the red test already passes on a clean checkout", async () => {
		await writeFile(join(root, "src/value.txt"), "ok\n");
		await exec(
			"git",
			[
				"-c",
				"user.name=t",
				"-c",
				"user.email=t@t",
				"commit",
				"-qam",
				"already fixed",
			],
			{ cwd: root },
		);

		const create = vi.fn();

		const outcome = await stage({ create } as unknown as MessagesApi).run(
			ctxWith("true", red),
		);

		expect(outcome).toMatchObject({ state: "halt" });
		expect(outcome.detail).toMatch(/passes on a clean checkout/);
		expect(create).not.toHaveBeenCalled();
	});

	it("fixes in a scratch checkout, records the change, and leaves the user's checkout alone", async () => {
		const create = vi
			.fn<MessagesApi["create"]>()
			.mockResolvedValueOnce(
				toolUse("1", "edit_file", {
					path: "src/value.txt",
					old_string: "bad\n",
					new_string: "ok\n",
				}),
			)
			.mockResolvedValueOnce(
				toolUse("2", "finish_fix", { summary: "fixed" }),
			);

		const ctx = ctxWith("true", red);

		const outcome = await stage({ create }).run(ctx);

		expect(outcome).toMatchObject({ state: "done" });
		expect(ctx.artifacts.fix).toMatchObject({
			status: "fixed",
			filesChanged: ["src/value.txt"],
		});
		expect(await readFile(join(root, "src/value.txt"), "utf8")).toBe(
			"bad\n",
		);

		const worktrees = await exec("git", ["worktree", "list"], {
			cwd: root,
		});

		expect(worktrees.stdout.trim().split("\n")).toHaveLength(1);
	});

	it("halts with the reason when the fix is not accepted", async () => {
		const create = vi.fn<MessagesApi["create"]>().mockResolvedValue({
			content: [{ type: "text", text: "giving up" }],
			stop_reason: "end_turn",
			usage: { input_tokens: 1, output_tokens: 1 },
		} as unknown as Anthropic.Message);

		const ctx = ctxWith("true", red);

		const outcome = await stage({ create }).run(ctx);

		expect(outcome).toMatchObject({ state: "halt" });
		expect(outcome.detail).toMatch(/^not fixed: /);
		expect(ctx.artifacts.fix?.status).toBe("not_fixed");
	});
});

describe("collectDiff", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "fixloop-diff-"));
		await exec("git", ["init", "-q"], { cwd: dir });
		await writeFile(join(dir, "a.txt"), "one\n");
		await exec("git", ["add", "."], { cwd: dir });
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
			{ cwd: dir },
		);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("includes new and changed files, and leaves out the red test", async () => {
		await writeFile(join(dir, "a.txt"), "two\n");
		await writeFile(join(dir, "new.txt"), "fresh\n");
		await mkdir(join(dir, "tests"), { recursive: true });
		await writeFile(join(dir, TEST), "red\n");

		const { diff, files } = await collectDiff(dir, TEST);

		expect(files.sort()).toEqual(["a.txt", "new.txt"]);
		expect(diff).toContain("+two");
		expect(diff).toContain("+fresh");
		expect(diff).not.toContain("red");
	});
});
