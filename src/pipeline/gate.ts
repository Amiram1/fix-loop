import { evaluateGate } from "../gate/gate.js";
import { gateInputFrom } from "../gate/input.js";
import type { Stage } from "./run.js";

/** Stage 6: the deterministic gate decides what happens to the fix. Writes `ctx.artifacts.gate`. */
export function makeGateStage(): Stage {
	return {
		name: "Gate",
		run: async (ctx) => {
			const gate = evaluateGate(gateInputFrom(ctx), {
				autonomy: ctx.config.autonomy,
				risk: ctx.config.risk,
			});

			ctx.artifacts.gate = gate;

			return {
				state: "done",
				detail: `${gate.delivery} (confidence ${gate.confidence.toFixed(2)}${gate.risky ? ", risky" : ""})`,
			};
		},
	};
}
