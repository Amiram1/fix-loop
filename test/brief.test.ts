import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetTracker } from "../src/agent/budget.js";
import type { MessagesApi } from "../src/agent/client.js";
import { generateBrief } from "../src/memory/brief.js";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "fixloop-brief-"));

	await writeFile(path.join(root, "README.md"), "# Demo\n");
});

afterEach(() => rm(root, { recursive: true, force: true }));

const message = (content: unknown[], stop_reason: string) =>
	({
		content,
		stop_reason,
		usage: { input_tokens: 1000, output_tokens: 200 },
	}) as unknown as Anthropic.Message;

const toolUse = (id: string) =>
	message(
		[
			{
				type: "tool_use",
				id,
				name: "read_file",
				input: { path: "README.md" },
			},
		],
		"tool_use",
	);

function breakpoints(params?: Anthropic.MessageCreateParamsNonStreaming) {
	return (params?.messages ?? []).flatMap((m, i) =>
		Array.isArray(m.content)
			? m.content.flatMap((b, j) =>
					"cache_control" in b && b.cache_control ? [[i, j]] : [],
				)
			: [],
	);
}

describe("generateBrief", () => {
	it("keeps one cache breakpoint on the newest message so history is read from cache", async () => {
		const create = vi.fn<MessagesApi["create"]>();

		create
			.mockResolvedValueOnce(toolUse("t1"))
			.mockResolvedValueOnce(toolUse("t2"))
			.mockResolvedValueOnce(
				message([{ type: "text", text: "# Brief" }], "end_turn"),
			);

		const result = await generateBrief({
			root,
			client: { create },
			model: "claude-sonnet-5-5",
			budget: new BudgetTracker(1),
			maxTurns: 25,
		});

		expect(result.text).toBe("# Brief");
		expect(result.turns).toBe(3);

		// Turn 1: [user]. Turn 2: [user, assistant, tool_results]. Turn 3 adds two more messages.
		expect(create.mock.calls.map(([p]) => p.messages.length)).toEqual([
			1, 3, 5,
		]);
		expect(breakpoints(create.mock.calls[0]?.[0])).toEqual([[0, 0]]);
		expect(breakpoints(create.mock.calls[1]?.[0])).toEqual([[2, 0]]);
		expect(breakpoints(create.mock.calls[2]?.[0])).toEqual([[4, 0]]);
	});

	it("tells the model the turn limit and caps the exploration it asks for", async () => {
		const create = vi.fn<MessagesApi["create"]>();

		create.mockResolvedValue(
			message([{ type: "text", text: "# Brief" }], "end_turn"),
		);

		const run = (maxTurns: number) =>
			generateBrief({
				root,
				client: { create },
				model: "claude-sonnet-5-5",
				budget: new BudgetTracker(1),
				maxTurns,
			});

		const prompt = (call: number) => {
			const content = create.mock.calls[call]?.[0].messages[0]?.content;

			return JSON.stringify(content);
		};

		await run(25);
		await run(6);

		expect(prompt(0)).toContain("at most 25 turns");
		expect(prompt(0)).toContain("after about 12 turns");
		expect(prompt(1)).toContain("at most 6 turns");
		expect(prompt(1)).toContain("after about 3 turns");
	});
});
