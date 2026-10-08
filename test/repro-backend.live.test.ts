// Real model and real Go against a Vikunja copy with a planted bug. Skipped unless opted in:
//   FIXLOOP_LIVE_REPRO=1 ANTHROPIC_API_KEY=... [FIXLOOP_VIKUNJA_DIR=/path/to/vikunja] \
//     npx vitest run test/repro-backend.live.test.ts
// The copy must contain the planted bug in pkg/utils/slice_difference.go (NotIn compares only slice2[0]).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BudgetTracker } from "../src/agent/budget.js";
import { createMessagesApi } from "../src/agent/client.js";
import { loadConfig } from "../src/config/load.js";
import { backendRunner } from "../src/repro/backend.js";
import { reproduce } from "../src/repro/loop.js";
import {
	createScratchCheckout,
	removeScratchCheckout,
} from "../src/repro/workspace.js";

const key = process.env.ANTHROPIC_API_KEY;

const enabled = process.env.FIXLOOP_LIVE_REPRO === "1" && Boolean(key);

const vikunja =
	process.env.FIXLOOP_VIKUNJA_DIR ?? "/Users/amirerell/Projects/vikunja";

describe("backend reproduction against Vikunja", () => {
	it.skipIf(!enabled)(
		"writes a failing test for the NotIn bug",
		async () => {
			const config = await loadConfig(join(vikunja, ".fixloop.yml"));

			// The Vikunja copy still hardcodes ./pkg/utils/; use the example's {{dir}} command instead.
			const example = await loadConfig("examples/vikunja/.fixloop.yml");

			const runner = backendRunner({
				...config,
				tests: { ...config.tests, backend: example.tests.backend },
			});

			if (!runner) throw new Error("tests.backend missing");

			const checkout = await createScratchCheckout(vikunja, "HEAD");

			try {
				const result = await reproduce({
					client: createMessagesApi(key),
					model: "claude-sonnet-5-5",
					budget: new BudgetTracker(0.75),
					runner,
					context: { checkout, env: {} },
					issue: {
						title: "Removing members from a team also removes the wrong people",
						body: "After an LDAP team sync, some users who are still in LDAP are removed from their Vikunja teams. It seems to depend on the order of the team IDs. Expected: only users that are no longer in LDAP are removed.",
					},
					maxTurns: 15,
				});

				const testFile =
					result.status === "reproduced"
						? await readFile(
								join(checkout, result.testPath),
								"utf8",
							)
						: "";

				console.log(JSON.stringify({ ...result, testFile }, null, 2));
				expect(result.status).toBe("reproduced");

				if (result.status === "reproduced") {
					expect(result.evidence).toMatch(/--- FAIL:/);
				}
			} finally {
				await removeScratchCheckout(checkout);
			}
		},
		20 * 60 * 1000,
	);
});
