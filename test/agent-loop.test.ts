import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { BudgetExceeded, BudgetTracker } from "../src/agent/budget.js";
import {
	type MessagesApi,
	runToolLoop,
	type ToolHandler,
} from "../src/agent/client.js";

const usage = { input_tokens: 1000, output_tokens: 100 };

function response(content: unknown[], stop_reason: string, u = usage) {
	return { content, stop_reason, usage: u } as unknown as Anthropic.Message;
}

function fakeClient(responses: Anthropic.Message[]) {
	const create = vi.fn<MessagesApi["create"]>();

	for (const r of responses) create.mockResolvedValueOnce(r);
	return { create } satisfies MessagesApi & { create: unknown };
}

const baseOpts = {
	model: "claude-haiku-5-5",
	system: [{ type: "text" as const, text: "sys" }],
	messages: [{ role: "user" as const, content: "hi" }],
	maxTurns: 5,
};

describe("runToolLoop", () => {
	it("returns the text on end_turn and records the cost", async () => {
		const client = fakeClient([
			response([{ type: "text", text: "done" }], "end_turn"),
		]);

		const budget = new BudgetTracker(1);

		const result = await runToolLoop({ ...baseOpts, client, budget });

		expect(result.text).toBe("done");
		expect(result.turns).toBe(1);
		expect(budget.spentUsd).toBeCloseTo(result.costUsd, 12);
	});

	it("runs a requested tool and sends the result back in the next turn", async () => {
		const client = fakeClient([
			response(
				[
					{
						type: "tool_use",
						id: "t1",
						name: "add",
						input: { a: 2, b: 3 },
					},
				],
				"tool_use",
			),
			response([{ type: "text", text: "5" }], "end_turn"),
		]);

		const add: ToolHandler = {
			definition: {
				name: "add",
				input_schema: { type: "object", properties: {} },
			},
			run: async (input) =>
				String(
					(input as { a: number; b: number }).a +
						(input as { a: number; b: number }).b,
				),
		};

		const result = await runToolLoop({
			...baseOpts,
			client,
			budget: new BudgetTracker(1),
			tools: [add],
		});

		expect(result.text).toBe("5");
		expect(result.turns).toBe(2);

		const secondCall = client.create.mock.calls[1]?.[0];

		expect(secondCall?.messages.at(-1)).toEqual({
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "t1", content: "5" }],
		});
	});

	it("reports a throwing tool to the model as an error result instead of failing the run", async () => {
		const client = fakeClient([
			response(
				[{ type: "tool_use", id: "t1", name: "boom", input: {} }],
				"tool_use",
			),
			response([{ type: "text", text: "recovered" }], "end_turn"),
		]);

		const boom: ToolHandler = {
			definition: {
				name: "boom",
				input_schema: { type: "object", properties: {} },
			},
			run: async () => {
				throw new Error("disk full");
			},
		};

		const result = await runToolLoop({
			...baseOpts,
			client,
			budget: new BudgetTracker(1),
			tools: [boom],
		});

		expect(result.text).toBe("recovered");

		const sent = client.create.mock.calls[1]?.[0].messages.at(-1);

		expect(sent).toEqual({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "t1",
					content: "disk full",
					is_error: true,
				},
			],
		});
	});

	it("answers an unknown tool name with an error result", async () => {
		const client = fakeClient([
			response(
				[{ type: "tool_use", id: "t1", name: "nope", input: {} }],
				"tool_use",
			),
			response([{ type: "text", text: "ok" }], "end_turn"),
		]);

		await runToolLoop({
			...baseOpts,
			client,
			budget: new BudgetTracker(1),
		});

		const sent = client.create.mock.calls[1]?.[0].messages.at(-1) as {
			content: unknown[];
		};

		expect(sent.content[0]).toMatchObject({
			is_error: true,
			content: 'unknown tool "nope"',
		});
	});

	it("throws on max_tokens rather than returning a truncated answer", async () => {
		const client = fakeClient([
			response([{ type: "text", text: "cut" }], "max_tokens"),
		]);

		await expect(
			runToolLoop({ ...baseOpts, client, budget: new BudgetTracker(1) }),
		).rejects.toThrow(/"max_tokens"/);
	});

	it("stops before calling the API once the budget is spent", async () => {
		const client = fakeClient([]);

		const budget = new BudgetTracker(0.01);

		budget.record(0.02);

		await expect(
			runToolLoop({ ...baseOpts, client, budget }),
		).rejects.toBeInstanceOf(BudgetExceeded);
		expect(client.create).not.toHaveBeenCalled();
	});

	it("stops after maxTurns when the model keeps asking for tools", async () => {
		const looping = response(
			[{ type: "tool_use", id: "t", name: "x", input: {} }],
			"tool_use",
		);

		const client = fakeClient([looping, looping]);

		const x: ToolHandler = {
			definition: {
				name: "x",
				input_schema: { type: "object", properties: {} },
			},
			run: async () => "",
		};

		await expect(
			runToolLoop({
				...baseOpts,
				maxTurns: 2,
				client,
				budget: new BudgetTracker(1),
				tools: [x],
			}),
		).rejects.toThrow(/after 2 turns/);
	});

	it("sends effort through output_config and caches nothing it was not asked to", async () => {
		const client = fakeClient([
			response([{ type: "text", text: "ok" }], "end_turn"),
		]);

		await runToolLoop({
			...baseOpts,
			client,
			budget: new BudgetTracker(1),
			effort: "low",
		});

		const params = client.create.mock.calls[0]?.[0];

		expect(params?.output_config).toEqual({ effort: "low" });
		expect(params).not.toHaveProperty("tools");
	});
});
