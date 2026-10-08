import type { Stage } from "./run.js";

// Real stage implementations land in Phase B (B2-B5). Until then each stage reports itself as skipped.
function placeholder(name: string): Stage {
	return {
		name,
		run: async () => ({ state: "skipped", detail: "not implemented yet" }),
	};
}

export const DEFAULT_STAGES: Stage[] = [
	"Intake",
	"Context",
	"Reproduce",
	"Fix",
	"Deliver",
].map(placeholder);
