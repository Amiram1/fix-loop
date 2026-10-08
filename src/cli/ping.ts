import { BudgetTracker } from "../agent/budget.js";
import { createMessagesApi, runToolLoop } from "../agent/client.js";
import { UsageError } from "./run.js";

const DEFAULT_MODEL = "claude-haiku-5-5";

const PING_BUDGET_USD = 0.05;

/**
 * One cheap live call to check the API key and the cost of a single request.
 * Hard-capped at $0.05 and runs with low effort.
 */
export async function pingCommand(argv: string[]): Promise<number> {
	const model = parseModel(argv);

	const apiKey = process.env.ANTHROPIC_API_KEY;

	if (!apiKey)
		throw new UsageError(
			"ANTHROPIC_API_KEY is not set (add it to .env or the environment)",
		);

	const result = await runToolLoop({
		client: createMessagesApi(apiKey),
		model,
		system: [{ type: "text", text: "Reply with the single word: pong" }],
		messages: [{ role: "user", content: "ping" }],
		maxTokens: 64,
		effort: "low",
		maxTurns: 1,
		budget: new BudgetTracker(PING_BUDGET_USD),
	});

	const { usage } = result;

	console.log(`model:  ${model}`);
	console.log(`reply:  ${result.text.trim()}`);
	console.log(
		`tokens: ${usage.input_tokens} in / ${usage.output_tokens} out` +
			` (cache read ${usage.cache_read_input_tokens ?? 0}, write ${usage.cache_creation_input_tokens ?? 0})`,
	);
	console.log(`cost:   $${result.costUsd.toFixed(6)}`);
	return 0;
}

function parseModel(argv: string[]): string {
	const i = argv.indexOf("--model");

	if (i === -1) return DEFAULT_MODEL;

	const value = argv[i + 1];

	if (!value || value.startsWith("--"))
		throw new UsageError("--model needs a value");

	return value;
}
