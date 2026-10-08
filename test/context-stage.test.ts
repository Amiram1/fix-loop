import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetTracker } from "../src/agent/budget.js";
import type { MessagesApi } from "../src/agent/client.js";
import { parseConfig } from "../src/config/load.js";
import {
	BRIEF_SYSTEM_PROMPT,
	briefKey,
	topLevelDirs,
} from "../src/memory/brief.js";
import { type BriefStore, localBriefStore } from "../src/memory/store.js";
import { makeContextStage } from "../src/pipeline/context.js";
import type { RunContext } from "../src/pipeline/run.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

const config = parseConfig(`
app:
  up: x
  base_url: http://localhost:3456
tests:
  full: make test
`);

const newCtx = (): RunContext => ({
	runId: "test",
	config,
	issue: { number: 1, title: "t", body: "", labels: [] },
	dryRun: true,
	artifacts: {},
});

function message(content: unknown[], stop_reason: string) {
	return {
		content,
		stop_reason,
		usage: { input_tokens: 1000, output_tokens: 200 },
	} as unknown as Anthropic.Message;
}

function fakeClient(responses: Anthropic.Message[]) {
	const create = vi.fn<MessagesApi["create"]>();

	for (const r of responses) create.mockResolvedValueOnce(r);

	return { create } satisfies MessagesApi & { create: unknown };
}

let root: string;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "fixloop-context-"));

	await mkdir(path.join(root, "src"));
	await mkdir(path.join(root, "docs"));
	await mkdir(path.join(root, "node_modules"));
	await writeFile(path.join(root, "package.json"), '{"name":"demo"}\n');
});

afterEach(() => rm(root, { recursive: true, force: true }));

describe("Context stage", () => {
	it("uses the stored brief without calling the model", async () => {
		const store = localBriefStore(root);

		await store.put(
			briefKey(SHA, await topLevelDirs(root)),
			"# Cached brief",
		);

		const client = fakeClient([]);

		const ctx = newCtx();

		const stage = makeContextStage({
			client,
			budget: new BudgetTracker(1),
			store,
			root,
			fingerprint: SHA,
		});

		expect(stage.name).toBe("Context");
		expect(await stage.run(ctx)).toEqual({
			state: "done",
			detail: "cached",
		});
		expect(ctx.artifacts.brief).toBe("# Cached brief");
		expect(client.create).not.toHaveBeenCalled();
	});

	it("generates with repo tools on a miss, stores the result, then hits on the next run", async () => {
		const client = fakeClient([
			message(
				[
					{
						type: "tool_use",
						id: "t1",
						name: "read_file",
						input: { path: "package.json" },
					},
				],
				"tool_use",
			),
			message(
				[{ type: "text", text: "\n# Brief\n\nA demo app.\n" }],
				"end_turn",
			),
		]);

		const budget = new BudgetTracker(1);

		const stage = makeContextStage({
			client,
			budget,
			store: localBriefStore(root),
			root,
			fingerprint: SHA,
		});

		const ctx = newCtx();

		expect(await stage.run(ctx)).toEqual({
			state: "done",
			detail: "generated",
		});
		expect(ctx.artifacts.brief).toBe("# Brief\n\nA demo app.");
		expect(client.create).toHaveBeenCalledTimes(2);
		expect(budget.spentUsd).toBeGreaterThan(0);

		const first = client.create.mock.calls[0]?.[0];

		expect(first?.model).toBe(config.models.fix);
		expect(first?.tools?.map((t) => t.name)).toEqual([
			"list_dir",
			"read_file",
			"grep",
		]);
		expect(first?.system).toEqual([
			{
				type: "text",
				text: BRIEF_SYSTEM_PROMPT,
				cache_control: { type: "ephemeral" },
			},
		]);

		// The tool ran against the real directory and its result went back to the model.
		const toolResult = client.create.mock.calls[1]?.[0].messages.at(-1) as {
			content: { content: string }[];
		};

		expect(toolResult.content[0]?.content).toContain('{"name":"demo"}');

		const again = newCtx();

		expect(await stage.run(again)).toEqual({
			state: "done",
			detail: "cached",
		});
		expect(again.artifacts.brief).toBe("# Brief\n\nA demo app.");
		expect(client.create).toHaveBeenCalledTimes(2);
	});

	it("misses when the commit changes or a top-level directory is added", async () => {
		const store = localBriefStore(root);

		const stage = (
			headSha: string,
			client: ReturnType<typeof fakeClient>,
		) =>
			makeContextStage({
				client,
				budget: new BudgetTracker(1),
				store,
				root,
				fingerprint: headSha,
			});

		const reply = () =>
			message([{ type: "text", text: "# New" }], "end_turn");

		await store.put(briefKey(SHA, await topLevelDirs(root)), "# Old");

		const newCommit = fakeClient([reply()]);

		expect(await stage("f".repeat(40), newCommit).run(newCtx())).toEqual({
			state: "done",
			detail: "generated",
		});
		expect(newCommit.create).toHaveBeenCalledOnce();

		await mkdir(path.join(root, "pkg"));

		const newDir = fakeClient([reply()]);

		expect(await stage(SHA, newDir).run(newCtx())).toEqual({
			state: "done",
			detail: "generated",
		});
		expect(newDir.create).toHaveBeenCalledOnce();
	});

	it("keys on real top-level directories only, not node_modules, vendor or its own store", async () => {
		const before = await topLevelDirs(root);

		await localBriefStore(root).put("x", "y");
		await mkdir(path.join(root, "vendor"));

		expect(await topLevelDirs(root)).toEqual(before);
		expect(before).toEqual(["docs", "src"]);
	});

	it("fails the stage without caching when the model returns an empty brief", async () => {
		const client = fakeClient([
			message([{ type: "text", text: "  " }], "end_turn"),
		]);

		const store: BriefStore = {
			get: vi.fn(async () => undefined),
			put: vi.fn(async () => {}),
		};

		const ctx = newCtx();

		await expect(
			makeContextStage({
				client,
				budget: new BudgetTracker(1),
				store,
				root,
				fingerprint: SHA,
			}).run(ctx),
		).rejects.toThrow(/empty brief/);
		expect(store.put).not.toHaveBeenCalled();
		expect(ctx.artifacts.brief).toBeUndefined();
	});
});
