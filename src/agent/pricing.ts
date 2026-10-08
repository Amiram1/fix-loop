// USD per million tokens. Source: Anthropic pricing (skill cache 2026-10-06).
// Unknown models throw rather than guessing a price.

export interface Usage {
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens?: number | null;
	cache_read_input_tokens?: number | null;
	cache_creation?: {
		ephemeral_5m_input_tokens?: number | null;
		ephemeral_1h_input_tokens?: number | null;
	} | null;
}

export interface Rate {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite5m: number;
	cacheWrite1h: number;
}

const HAIKU_THRESHOLD_TOKENS = 100_000;

const HAIKU_SHORT: Rate = {
	input: 0.1,
	output: 0.5,
	cacheRead: 0.01,
	cacheWrite5m: 0.125,
	cacheWrite1h: 0.2,
};

const HAIKU_LONG: Rate = {
	input: 0.5,
	output: 2.5,
	cacheRead: 0.05,
	cacheWrite5m: 0.625,
	cacheWrite1h: 1.0,
};

const RATES: Record<string, Rate> = {
	"claude-opus-5-5": {
		input: 4,
		output: 20,
		cacheRead: 0.2,
		cacheWrite5m: 5,
		cacheWrite1h: 8,
	},
	"claude-sonnet-5-5": {
		input: 2,
		output: 10,
		cacheRead: 0.2,
		cacheWrite5m: 2.5,
		cacheWrite1h: 4,
	},
};

/** Haiku 5.5 has two rate cards, chosen by prompt length (100K tokens or fewer is the cheap one). */
export function rateFor(model: string, promptTokens: number): Rate {
	if (model === "claude-haiku-5-5") {
		return promptTokens > HAIKU_THRESHOLD_TOKENS ? HAIKU_LONG : HAIKU_SHORT;
	}

	const rate = RATES[model];

	if (!rate) throw new Error(`no pricing configured for model "${model}"`);

	return rate;
}

/** Cost of one response. Cache writes without a TTL breakdown are billed at the 5-minute rate. */
export function costUsd(model: string, usage: Usage): number {
	const cacheRead = usage.cache_read_input_tokens ?? 0;

	const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;

	const write5m = usage.cache_creation
		? (usage.cache_creation.ephemeral_5m_input_tokens ?? 0)
		: (usage.cache_creation_input_tokens ?? 0);

	const promptTokens = usage.input_tokens + cacheRead + write5m + write1h;

	const rate = rateFor(model, promptTokens);

	const dollars =
		usage.input_tokens * rate.input +
		usage.output_tokens * rate.output +
		cacheRead * rate.cacheRead +
		write5m * rate.cacheWrite5m +
		write1h * rate.cacheWrite1h;

	return dollars / 1_000_000;
}
