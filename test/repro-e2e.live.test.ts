import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BudgetTracker } from "../src/agent/budget.js";
import { createMessagesApi } from "../src/agent/client.js";
import { bootApp } from "../src/boot/boot.js";
import { loadConfig } from "../src/config/load.js";
import { classifyE2e, frontendRunner } from "../src/repro/frontend.js";
import { reproduce } from "../src/repro/loop.js";
import {
	createScratchCheckout,
	removeScratchCheckout,
} from "../src/repro/workspace.js";

// Costs real money. Builds and boots the Vikunja stack with Docker, installs the Playwright browser,
// and lets the model write a Playwright spec against it (bug: getHumanSize divides by 1000, not 1024).
// Run: FIXLOOP_LIVE_REPRO=1 ANTHROPIC_API_KEY=... npx vitest run test/repro-e2e.live.test.ts
// Optional: FIXLOOP_LIVE_REPO (Vikunja checkout; its compose file and seed script must be committed).
// Uses examples/vikunja/.fixloop.yml because the Vikunja checkout's own config has no tests.e2e.
const key = process.env.ANTHROPIC_API_KEY;

const enabled = process.env.FIXLOOP_LIVE_REPRO === "1" && Boolean(key);

const repo =
	process.env.FIXLOOP_LIVE_REPO ?? "/Users/amirerell/Projects/vikunja";

describe("e2e reproduction, live", () => {
	it.skipIf(!enabled)(
		"reproduces the getHumanSize bug through the UI",
		async () => {
			const config = await loadConfig(
				join(import.meta.dirname, "../examples/vikunja/.fixloop.yml"),
			);

			const runner = frontendRunner(config);

			if (!runner) throw new Error("config has no frontend or e2e tests");

			const app = await bootApp({ config, cwd: repo });

			try {
				const ctx = {
					checkout: await createScratchCheckout(repo, "HEAD"),
					env: { FIXLOOP_BASE_URL: app.baseUrl },
				};

				try {
					await runner.prepare?.(ctx);

					const result = await reproduce({
						client: createMessagesApi(key),
						model: "claude-sonnet-5-5",
						budget: new BudgetTracker(1),
						runner,
						context: ctx,
						issue: {
							title: "Storage sizes are off",
							body: "A file that is exactly 2 KB shows up as 2.05 KB in the file list. Larger files are a bit off too.",
						},
						maxTurns: 20,
					});

					const written =
						result.testPath !== undefined
							? await readFile(
									join(ctx.checkout, result.testPath),
									"utf8",
								)
							: "";

					console.log(JSON.stringify(result, null, 2));
					console.log(`--- spec file ---\n${written}`);

					expect(result.status).toBe("reproduced");
					expect(result.testPath).toMatch(/\.spec\.ts$/);

					expect(
						classifyE2e(
							{ exitCode: 1, output: result.evidence ?? "" },
							{
								file: result.testPath ?? "",
								name: result.testName ?? "",
							},
						).red,
					).toBe(true);
				} finally {
					await removeScratchCheckout(ctx.checkout);
				}
			} finally {
				await app.stop();
			}
		},
		60 * 60_000,
	);
});
