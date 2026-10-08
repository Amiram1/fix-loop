import type { FixLoopConfig } from "../config/schema.js";
import type { AreaRunner } from "./runner.js";

/** Placeholder until the frontend runner lands. Returning undefined makes Reproduce halt. */
export function frontendRunner(_config: FixLoopConfig): AreaRunner | undefined {
	return undefined;
}
