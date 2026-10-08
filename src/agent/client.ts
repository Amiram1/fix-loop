import Anthropic from "@anthropic-ai/sdk";
import type { BudgetTracker } from "./budget.js";
import { costUsd, type Usage } from "./pricing.js";

/** The slice of the SDK the loop uses. Tests pass a fake; production passes `new Anthropic().messages`. */
export interface MessagesApi {
	create: (
		params: Anthropic.MessageCreateParamsNonStreaming,
	) => Promise<Anthropic.Message>;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ToolHandler {
	definition: Anthropic.Tool;
	/** Throws to report a failure; the message is returned to the model as an error tool_result. */
	run: (input: unknown) => Promise<string>;
}

export interface LoopOptions {
	client: MessagesApi;
	model: string;
	system: Anthropic.TextBlockParam[];
	messages: Anthropic.MessageParam[];
	tools?: ToolHandler[];
	maxTokens?: number;
	effort?: Effort;
	maxTurns: number;
	budget: BudgetTracker;
}

export interface LoopResult {
	text: string;
	turns: number;
	usage: Usage;
	costUsd: number;
}

export function createMessagesApi(apiKey?: string): MessagesApi {
	return new Anthropic({ apiKey }).messages;
}

/**
 * Marks the stable part of a system prompt for caching. Put everything that does not change
 * between calls (codebase brief, instructions) in `stable`, and per-call content elsewhere.
 */
export function cachedSystem(
	stable: string,
	volatile?: string,
): Anthropic.TextBlockParam[] {
	const blocks: Anthropic.TextBlockParam[] = [
		{ type: "text", text: stable, cache_control: { type: "ephemeral" } },
	];

	if (volatile) blocks.push({ type: "text", text: volatile });

	return blocks;
}

/**
 * Copies the history with a cache breakpoint on its last block. Each turn then reads the
 * earlier turns from cache instead of paying the full input rate for all of them again.
 * The loop's own array is not touched.
 */
function withConversationCache(
	messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
	// The client gets a snapshot, not the loop's array, which keeps growing after the call.
	// A single-turn prompt has no earlier history to reuse, so it is sent without a breakpoint.
	if (messages.length < 2) return [...messages];

	const last = messages.at(-1);

	if (!last) return [...messages];

	const blocks: Anthropic.ContentBlockParam[] =
		typeof last.content === "string"
			? [{ type: "text", text: last.content }]
			: [...last.content];

	const tail = blocks.pop();

	if (!tail) return [...messages];

	blocks.push({
		...tail,
		cache_control: { type: "ephemeral" },
	} as Anthropic.ContentBlockParam);
	return [...messages.slice(0, -1), { role: last.role, content: blocks }];
}

const emptyUsage = (): Usage => ({
	input_tokens: 0,
	output_tokens: 0,
	cache_creation_input_tokens: 0,
	cache_read_input_tokens: 0,
});

function addUsage(total: Usage, u: Usage): void {
	total.input_tokens += u.input_tokens;
	total.output_tokens += u.output_tokens;
	total.cache_creation_input_tokens =
		(total.cache_creation_input_tokens ?? 0) +
		(u.cache_creation_input_tokens ?? 0);
	total.cache_read_input_tokens =
		(total.cache_read_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
}

function textOf(content: Anthropic.ContentBlock[]): string {
	return content
		.filter((b): b is Anthropic.TextBlock => b.type === "text")
		.map((b) => b.text)
		.join("");
}

/**
 * Calls the model until it stops with end_turn, running any tools it requests in between.
 * Throws on max_tokens, refusal, pause_turn, budget exhaustion, or when maxTurns is reached.
 */
export async function runToolLoop(opts: LoopOptions): Promise<LoopResult> {
	const tools = opts.tools ?? [];

	const handlers = new Map(tools.map((t) => [t.definition.name, t]));

	const messages: Anthropic.MessageParam[] = [...opts.messages];

	const usage = emptyUsage();

	let spent = 0;

	for (let turn = 1; turn <= opts.maxTurns; turn++) {
		opts.budget.assertCanSpend();

		const response = await opts.client.create({
			model: opts.model,
			max_tokens: opts.maxTokens ?? 16000,
			system: opts.system,
			messages: withConversationCache(messages),
			...(tools.length > 0
				? { tools: tools.map((t) => t.definition) }
				: {}),
			...(opts.effort ? { output_config: { effort: opts.effort } } : {}),
		});

		const cost = costUsd(opts.model, response.usage);

		opts.budget.record(cost);
		spent += cost;
		addUsage(usage, response.usage);

		if (
			response.stop_reason === "end_turn" ||
			response.stop_reason === "stop_sequence"
		) {
			return {
				text: textOf(response.content),
				turns: turn,
				usage,
				costUsd: spent,
			};
		}

		if (response.stop_reason !== "tool_use") {
			throw new Error(
				`model stopped with "${response.stop_reason}" before finishing`,
			);
		}

		messages.push({ role: "assistant", content: response.content });

		const results: Anthropic.ToolResultBlockParam[] = [];

		for (const block of response.content) {
			if (block.type !== "tool_use") continue;

			results.push(await runTool(handlers.get(block.name), block));
		}
		messages.push({ role: "user", content: results });
	}

	throw new Error(`no final answer after ${opts.maxTurns} turns`);
}

async function runTool(
	handler: ToolHandler | undefined,
	block: Anthropic.ToolUseBlock,
): Promise<Anthropic.ToolResultBlockParam> {
	if (!handler) {
		return {
			type: "tool_result",
			tool_use_id: block.id,
			content: `unknown tool "${block.name}"`,
			is_error: true,
		};
	}

	try {
		const content = await handler.run(block.input);

		return { type: "tool_result", tool_use_id: block.id, content };
	} catch (err) {
		return {
			type: "tool_result",
			tool_use_id: block.id,
			content: (err as Error).message,
			is_error: true,
		};
	}
}
