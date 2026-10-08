import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.js";

describe("examples/vikunja/.fixloop.yml", () => {
	it("validates against the schema", async () => {
		const src = await readFile("examples/vikunja/.fixloop.yml", "utf8");

		const cfg = parseConfig(src);

		expect(cfg.models).toEqual({
			triage: "claude-haiku-5-5",
			fix: "claude-haiku-5-5",
			escalate: "claude-haiku-5-5",
		});
		expect(cfg.effort).toEqual({
			triage: "low",
			reproduce: "low",
			fix: "low",
			escalate: "low",
		});
	});
});
