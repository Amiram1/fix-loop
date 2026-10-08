import type { FixLoopConfig } from "./schema.js";

export const DEV_MODEL = "claude-haiku-5-5";

/** Forces every stage onto Haiku. Used by `fixloop run --dev` to keep development spend low. */
export function withDevModels(config: FixLoopConfig): FixLoopConfig {
	return {
		...config,
		models: { triage: DEV_MODEL, fix: DEV_MODEL, escalate: DEV_MODEL },
	};
}
