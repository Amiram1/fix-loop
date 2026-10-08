import type { FixLoopConfig } from "../config/schema.js";
import type { AreaRunner } from "./runner.js";

/** Placeholder until the backend runner lands. Returning undefined makes Reproduce halt. */
export function backendRunner(_config: FixLoopConfig): AreaRunner | undefined {
	return undefined;
}
