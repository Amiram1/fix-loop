import { describe, expect, it } from "vitest";
import { costUsd, rateFor } from "../src/agent/pricing.js";

const usage = (over: Partial<Parameters<typeof costUsd>[1]> = {}) => ({
	input_tokens: 0,
	output_tokens: 0,
	...over,
});

describe("costUsd", () => {
	it("prices Haiku 5.5 on the short rate card (prompt of 100K tokens or fewer)", () => {
		// 100K input at $0.10 + 1M output at $0.50 (output does not count towards the prompt length)
		expect(
			costUsd(
				"claude-haiku-5-5",
				usage({ input_tokens: 100_000, output_tokens: 1_000_000 }),
			),
		).toBeCloseTo(0.51, 10);
	});

	it("switches Haiku 5.5 to the long rate card above 100K prompt tokens", () => {
		// 150K input at $0.50/MTok, nothing else
		expect(
			costUsd("claude-haiku-5-5", usage({ input_tokens: 150_000 })),
		).toBeCloseTo(0.075, 10);
	});

	it("counts cache reads and writes towards the Haiku tier boundary", () => {
		// 60K uncached + 50K cache read = 110K prompt tokens, so the long rate card applies to the read too
		const cost = costUsd(
			"claude-haiku-5-5",
			usage({ input_tokens: 60_000, cache_read_input_tokens: 50_000 }),
		);

		expect(cost).toBeCloseTo(
			(60_000 * 0.5 + 50_000 * 0.05) / 1_000_000,
			10,
		);
	});

	it("uses the 100K boundary as the short rate card", () => {
		expect(rateFor("claude-haiku-5-5", 100_000).input).toBe(0.1);
		expect(rateFor("claude-haiku-5-5", 100_001).input).toBe(0.5);
	});

	it("prices Opus 5.5 cache reads at $0.20/MTok and 5-minute writes at 1.25x", () => {
		const cost = costUsd(
			"claude-opus-5-5",
			usage({
				cache_read_input_tokens: 1_000_000,
				cache_creation_input_tokens: 1_000_000,
			}),
		);

		expect(cost).toBeCloseTo(0.2 + 5, 10);
	});

	it("bills the 1-hour cache writes at 2x when the TTL breakdown is present", () => {
		const cost = costUsd(
			"claude-sonnet-5-5",
			usage({
				cache_creation_input_tokens: 1_000_000,
				cache_creation: {
					ephemeral_5m_input_tokens: 0,
					ephemeral_1h_input_tokens: 1_000_000,
				},
			}),
		);

		expect(cost).toBeCloseTo(4, 10);
	});

	it("throws for a model without a price instead of guessing", () => {
		expect(() =>
			costUsd("claude-mystery-9", usage({ input_tokens: 1 })),
		).toThrow(/no pricing/);
	});
});
