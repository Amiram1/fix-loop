import { readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { BudgetTracker } from "../src/agent/budget.js";
import { createMessagesApi } from "../src/agent/client.js";
import { loadConfig } from "../src/config/load.js";
import { classifyFrontend, frontendRunner } from "../src/repro/frontend.js";
import { reproduce } from "../src/repro/loop.js";
import {
	createScratchCheckout,
	removeScratchCheckout,
} from "../src/repro/workspace.js";

// Costs real money and needs pnpm, network and a Vikunja copy with a planted bug in getHumanSize.
// Run: FIXLOOP_LIVE_REPRO=1 ANTHROPIC_API_KEY=... npx vitest run test/repro-frontend.live.test.ts
// Optional: FIXLOOP_LIVE_REPO (repo path), FIXLOOP_PNPM_DIR (directory holding a `pnpm` to put on PATH).
const key = process.env.ANTHROPIC_API_KEY;

const enabled = process.env.FIXLOOP_LIVE_REPRO === "1" && Boolean(key);

const repo =
	process.env.FIXLOOP_LIVE_REPO ?? "/Users/amirerell/Projects/vikunja";

describe("frontend reproduction, live", () => {
	it.skipIf(!enabled)(
		"reproduces the getHumanSize bug from a user-style report",
		async () => {
			const config = await loadConfig(join(repo, ".fixloop.yml"));

			const runner = frontendRunner(config);

			if (!runner) throw new Error("config has no tests.frontend");

			const pnpmDir = process.env.FIXLOOP_PNPM_DIR;

			const ctx = {
				checkout: await createScratchCheckout(repo, "HEAD"),
				env: {
					COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
					...(pnpmDir
						? {
								PATH: `${pnpmDir}${delimiter}${process.env.PATH ?? ""}`,
							}
						: {}),
				},
			};

			try {
				await runner.prepare?.(ctx);

				const result = await reproduce({
					client: createMessagesApi(key),
					model: "claude-sonnet-5-5",
					budget: new BudgetTracker(0.75),
					runner,
					context: ctx,
					issue: {
						title: "Storage sizes are off",
						body: "A file that is exactly 2 KB shows up as 2.05 KB in the file list. Larger files are a bit off too.",
					},
					maxTurns: 15,
				});

				const written =
					result.status === "reproduced" && result.testPath
						? await readFile(
								join(ctx.checkout, result.testPath),
								"utf8",
							)
						: "";

				console.log(JSON.stringify(result, null, 2));
				console.log(`--- test file ---\n${written}`);

				expect(result.status).toBe("reproduced");

				expect(
					classifyFrontend({
						exitCode: 1,
						output: result.evidence ?? "",
					}).red,
				).toBe(true);
			} finally {
				await removeScratchCheckout(repo, ctx.checkout);
			}
		},
		20 * 60_000,
	);
});
