import type { FixLoopConfig } from "../config/schema.js";
import { backendRunner } from "./backend.js";
import { frontendRunner } from "./frontend.js";
import type { AreaRunner } from "./runner.js";

export function defaultRunners(
	config: FixLoopConfig,
): Partial<Record<"backend" | "frontend", AreaRunner>> {
	return { backend: backendRunner(config), frontend: frontendRunner(config) };
}
