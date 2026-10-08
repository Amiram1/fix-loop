import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetTracker } from "../src/agent/budget.js";
import type { MessagesApi } from "../src/agent/client.js";
import { parseConfig } from "../src/config/load.js";
import { makeReproduceStage } from "../src/pipeline/reproduce.js";
import type { RunContext } from "../src/pipeline/run.js";
import type { AreaRunner } from "../src/repro/runner.js";

const exec = promisify(execFile);

const config = parseConfig(
	"app:\n  up: x\n  base_url: http://localhost:3456\ntests:\n  full: make test\n",
);

function ctxWith(area?: "backend" | "frontend"): RunContext {
	return {
		runId: "t",
		config,
		issue: {
			number: 1,
			title: "NotIn drops items",
			body: "NotIn([9],[1,9]) returns [9]",
		},
		dryRun: true,
		artifacts: area
			? {
					intake: {
						area,
						severity: "S2",
						summary: "s",
						injectionSuspected: false,
					},
				}
			: {},
	};
}

describe("makeReproduceStage", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "fixloop-stage-test-"));
		await exec("git", ["init", "-q"], { cwd: root });
		await writeFile(join(root, "a.go"), "package a\n");
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

	it("halts without calling the model when the area is unknown", async () => {
		const create = vi.fn();

		const stage = makeReproduceStage({
			client: { create } as unknown as MessagesApi,
			budget: new BudgetTracker(1),
			root,
			headSha: "HEAD",
			runners: {},
		});

		const outcome = await stage.run(ctxWith(undefined));

		expect(outcome).toMatchObject({ state: "skipped" });
		expect(create).not.toHaveBeenCalled();
	});

	it("writes the test in a scratch checkout, reports reproduced, and leaves the user's repo alone", async () => {
		const runner: AreaRunner = {
			area: "backend",
			testGlobs: ["*_test.go"],
			hints: "",
			runTest: vi.fn(async () => ({
				exitCode: 1,
				output: "--- FAIL: TestX",
			})),
			classify: () => ({ red: true, reason: "assertion failed" }),
		};

		const msg = (content: unknown[], stop_reason: string) =>
			({
				content,
				stop_reason,
				usage: { input_tokens: 10, output_tokens: 5 },
			}) as unknown as Anthropic.Message;

		const create = vi
			.fn<MessagesApi["create"]>()
			.mockResolvedValueOnce(
				msg(
					[
						{
							type: "tool_use",
							id: "1",
							name: "write_test_file",
							input: { path: "x_test.go", content: "package a" },
						},
					],
					"tool_use",
				),
			)
			.mockResolvedValueOnce(
				msg(
					[
						{
							type: "tool_use",
							id: "2",
							name: "run_test",
							input: { file: "x_test.go", name: "TestX" },
						},
					],
					"tool_use",
				),
			)
			.mockResolvedValueOnce(
				msg(
					[
						{
							type: "tool_use",
							id: "3",
							name: "finish_reproduction",
							input: { file: "x_test.go", name: "TestX" },
						},
					],
					"tool_use",
				),
			)
			.mockResolvedValueOnce(
				msg([{ type: "text", text: "done" }], "end_turn"),
			);

		const stage = makeReproduceStage({
			client: { create },
			budget: new BudgetTracker(1),
			root,
			headSha: "HEAD",
			runners: { backend: runner },
		});

		const ctx = ctxWith("backend");

		const outcome = await stage.run(ctx);

		expect(outcome).toMatchObject({
			state: "done",
			detail: "x_test.go is red",
		});
		expect(ctx.artifacts.reproduction).toMatchObject({
			status: "reproduced",
			testPath: "x_test.go",
		});
		await expect(access(join(root, "x_test.go"))).rejects.toThrow();

		const worktrees = await exec("git", ["worktree", "list"], {
			cwd: root,
		});

		expect(worktrees.stdout.trim().split("\n")).toHaveLength(1);
	});
});
