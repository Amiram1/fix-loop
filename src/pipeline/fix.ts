import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BudgetTracker } from "../agent/budget.js";
import type { MessagesApi } from "../agent/client.js";
import { fixBug } from "../fix/loop.js";
import {
	type AreaRunner,
	type RunContext,
	safeRelativePath,
} from "../repro/runner.js";
import {
	createScratchCheckout,
	removeScratchCheckout,
} from "../repro/workspace.js";
import type { Stage } from "./run.js";

export interface FixDeps {
	client: MessagesApi;
	budget: BudgetTracker;
	root: string;
	headSha: string;
	runners: Partial<Record<"backend" | "frontend", AreaRunner>>;
	maxTurns?: number;
}

/**
 * Stage 5: changes the code until the red test from Reproduce passes and the full suite is green.
 * The fix is made in a fresh scratch checkout of the same commit, so the user's checkout is untouched.
 */
export function makeFixStage(deps: FixDeps): Stage {
	return {
		name: "Fix",
		run: async (ctx) => {
			const repro = ctx.artifacts.reproduction;

			if (
				repro?.status !== "reproduced" ||
				!repro.testPath ||
				!repro.testName ||
				repro.testContent === undefined
			) {
				return { state: "halt", detail: "no red test to fix against" };
			}

			const runner = deps.runners[repro.area];

			if (!runner) {
				return {
					state: "halt",
					detail: `no runner for area "${repro.area}"`,
				};
			}

			const testPath = safeRelativePath(repro.testPath);

			if (!testPath)
				throw new Error(`unsafe test path ${repro.testPath}`);

			const checkout = await createScratchCheckout(
				deps.root,
				deps.headSha,
			);

			try {
				await mkdir(dirname(join(checkout, testPath)), {
					recursive: true,
				});
				await writeFile(join(checkout, testPath), repro.testContent);

				const context: RunContext = {
					checkout,
					env: ctx.artifacts.app
						? { FIXLOOP_BASE_URL: ctx.artifacts.app.baseUrl }
						: {},
				};

				if (runner.prepare) await runner.prepare(context);

				// The fix only means something if the test fails before any change is made.
				const baseline = await runner.runTest(
					{ file: testPath, name: repro.testName },
					context,
				);

				if (baseline.exitCode === 0) {
					return {
						state: "halt",
						detail: "the red test passes on a clean checkout; it no longer shows the bug",
					};
				}

				const fix = await fixBug({
					client: deps.client,
					budget: deps.budget,
					runner,
					context,
					red: {
						testPath,
						testName: repro.testName,
						evidence: repro.evidence,
					},
					issue: ctx.issue,
					fullCommand: ctx.config.tests.full,
					fixModel: ctx.config.models.fix,
					escalateModel: ctx.config.models.escalate,
					maxAttempts: ctx.config.budget.max_fix_iterations,
					maxTurns: deps.maxTurns ?? 30,
				});

				ctx.artifacts.fix = fix;

				if (fix.status === "fixed") {
					return {
						state: "done",
						detail: `${fix.filesChanged.length} file(s) changed; target test and full suite pass`,
					};
				}

				return { state: "halt", detail: `not fixed: ${fix.reason}` };
			} finally {
				await removeScratchCheckout(deps.root, checkout);
			}
		},
	};
}
