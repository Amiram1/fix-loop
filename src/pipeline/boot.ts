import { type BootDeps, bootApp } from "../boot/boot.js";
import type { RunContext, Stage } from "./run.js";

export interface BootStageDeps extends BootDeps {
	/** Where the target repo is checked out. Defaults to the process working directory. */
	cwd?: string;
}

/** Stage 3: starts the app, waits for health, seeds, and publishes `ctx.artifacts.app`. */
export function makeBootStage(deps: BootStageDeps = {}): Stage {
	return {
		name: "Boot",
		run: async (ctx) => {
			// Only a frontend report can need the running app (its UI tests). Building and starting the
			// app takes minutes on a fresh runner, so a backend or unknown-area run does not pay for it.
			if (ctx.artifacts.intake?.area !== "frontend") {
				return {
					state: "skipped",
					detail: `no app needed for area "${ctx.artifacts.intake?.area ?? "unknown"}"`,
				};
			}

			const app = await bootApp({
				...deps,
				config: ctx.config,
				cwd: deps.cwd ?? process.cwd(),
			});

			ctx.artifacts.app = app;
			return { state: "done", detail: app.baseUrl };
		},
	};
}

/**
 * Wrap the whole pipeline run in this so the app is torn down however the run ends:
 * `withBootedApp(ctx, () => runPipeline(ctx, stages, reporter))`. A stage that throws
 * is caught by runPipeline, and a crash outside it is caught here. If the wrapped work
 * failed, a failing `stop` is ignored so it cannot hide the original error.
 */
export async function withBootedApp<T>(
	ctx: RunContext,
	fn: () => Promise<T>,
): Promise<T> {
	let result: T;

	try {
		result = await fn();
	} catch (err) {
		await ctx.artifacts.app?.stop().catch(() => undefined);
		throw err;
	}
	await ctx.artifacts.app?.stop();
	return result;
}
