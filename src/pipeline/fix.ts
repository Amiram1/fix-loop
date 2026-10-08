import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BudgetTracker } from "../agent/budget.js";
import type { MessagesApi } from "../agent/client.js";
import { type bootApp, bootApp as defaultBoot } from "../boot/boot.js";
import {
	AppStartError,
	fixBug,
	runRedTest,
	type WithApp,
} from "../fix/loop.js";
import type { DataStore } from "../memory/datastore.js";
import {
	type AreaRunner,
	type RunContext,
	safeRelativePath,
	type TestRun,
} from "../repro/runner.js";
import {
	createScratchCheckout,
	removeScratchCheckout,
} from "../repro/workspace.js";
import { hintsFor } from "./hints.js";
import type { Stage } from "./run.js";

export interface FixDeps {
	client: MessagesApi;
	budget: BudgetTracker;
	root: string;
	headSha: string;
	runners: Partial<Record<"backend" | "frontend", AreaRunner>>;
	maxTurns?: number;
	/** Where journal entries from earlier runs are kept. Without it no hints are passed. */
	store?: DataStore;
	/** Boots an app from a directory. Injectable for tests. */
	boot?: typeof bootApp;
}

/**
 * Stage 5: changes the code until the red test from Reproduce passes and the full suite is green.
 * The fix is made in a fresh scratch checkout of the same commit, so the user's checkout is untouched.
 * A UI test runs against an app booted from that scratch checkout, so the change is what gets tested.
 */
export function makeFixStage(deps: FixDeps): Stage {
	const boot = deps.boot ?? defaultBoot;

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
				return {
					state: "skipped",
					detail: "no red test to fix against",
				};
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

				// Both the running root app and the scratch app use the same port, so the root app goes first.
				const withApp: WithApp = async (fn) => {
					try {
						await ctx.artifacts.app?.stop();
					} catch (err) {
						throw new AppStartError(
							`could not stop the running app: ${(err as Error).message}`,
						);
					}

					let app: Awaited<ReturnType<typeof bootApp>>;

					try {
						app = await boot({ config: ctx.config, cwd: checkout });
					} catch (err) {
						throw new AppStartError((err as Error).message);
					}

					try {
						return await fn({ FIXLOOP_BASE_URL: app.baseUrl });
					} finally {
						await app.stop();
					}
				};

				const revise = ctx.artifacts.revise;

				// The fix only means something if the red test fails before any change is made.
				// A review-feedback pass starts from the PR branch, where the test already passes.
				let baseline: TestRun | undefined;

				try {
					baseline = revise
						? undefined
						: await runRedTest(
								runner,
								{ file: testPath, name: repro.testName },
								context,
								withApp,
							);
				} catch (err) {
					if (err instanceof AppStartError) {
						return {
							state: "skipped",
							detail: `could not start the app from the clean checkout: ${err.message}`,
						};
					}

					throw err;
				}

				if (baseline?.exitCode === 0) {
					return {
						state: "skipped",
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
					issue: revise
						? {
								...ctx.issue,
								replies: [
									...(ctx.issue.replies ?? []),
									`Review feedback on the pull request, which already holds a fix for this bug. Address it: ${revise.reviewText}`,
								],
							}
						: ctx.issue,
					fullCommand: ctx.config.tests.full,
					fixModel: ctx.config.models.fix,
					escalateModel: ctx.config.models.escalate,
					maxAttempts: ctx.config.budget.max_fix_iterations,
					maxTurns: deps.maxTurns ?? 30,
					hints: await hintsFor(deps.store, ctx),
					withApp,
					effort: {
						fix: ctx.config.effort.fix,
						escalate: ctx.config.effort.escalate,
					},
				});

				ctx.artifacts.fix = fix;

				const via = fix.models.join(" → ") || "no model ran";

				if (fix.status === "fixed") {
					return {
						state: "done",
						detail: `${fix.filesChanged.length} file(s) changed via ${via}; target test and full suite pass`,
					};
				}

				// The status line keeps the first line; the full reason is on the Fix result.
				const headline = (fix.reason ?? "").split("\n")[0];

				return {
					state: "skipped",
					detail: `not fixed (${via}): ${headline}`,
				};
			} finally {
				await removeScratchCheckout(checkout);
			}
		},
	};
}
