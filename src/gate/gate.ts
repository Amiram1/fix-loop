import { matchesGlob } from "node:path";
import type { FixLoopConfig } from "../config/schema.js";
import type { GateResult } from "../pipeline/artifacts.js";
import type { GateInput } from "./input.js";

/**
 * PLAN.md section 2 weights, in hundredths. The plan has a fifth term, 0.1 for an LLM
 * self-assessment, that is not implemented: the gate stays free of model calls. The four weights
 * left sum to 0.9, so confidence divides by that total and a run that passes everything scores 1.
 * Whole numbers keep the sum exact: 80 / 90 compares the same against a threshold every time.
 */
export const WEIGHTS = {
	reproduced: 35,
	targetGreen: 25,
	suiteGreen: 20,
	withinSizeLimit: 10,
} as const;

const TOTAL_WEIGHT = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);

type GateConfig = Pick<FixLoopConfig, "autonomy" | "risk">;

/** A glob that ends in "/" names a directory, so it covers everything below it. */
const matchesPath = (file: string, glob: string) =>
	matchesGlob(file, glob.endsWith("/") ? `${glob}**` : glob);

/** Why a change counts as risky. Empty when it does not. Also used for the PR body. */
export function riskReasons(
	input: GateInput,
	risk: GateConfig["risk"],
): string[] {
	const reasons: string[] = [];

	const hits = input.filesChanged.filter((file) =>
		risk.high_paths.some((glob) => matchesPath(file, glob)),
	);

	if (hits.length > 0)
		reasons.push(`Touches high-risk paths: ${hits.join(", ")}.`);

	if (input.severity === "S1") reasons.push("The issue is severity S1.");

	if (input.diffLines > risk.max_diff_lines) {
		reasons.push(
			`The diff changes ${input.diffLines} lines, over the limit of ${risk.max_diff_lines}.`,
		);
	}

	return reasons;
}

/** Pure and deterministic: the same signals and config always give the same result. */
export function evaluateGate(
	input: GateInput,
	{ autonomy, risk }: GateConfig,
): GateResult {
	const withinSizeLimit = input.diffLines <= risk.max_diff_lines;

	const points =
		(input.reproduced ? WEIGHTS.reproduced : 0) +
		(input.targetGreen ? WEIGHTS.targetGreen : 0) +
		(input.suiteGreen ? WEIGHTS.suiteGreen : 0) +
		(withinSizeLimit ? WEIGHTS.withinSizeLimit : 0);

	const confidence = points / TOTAL_WEIGHT;

	const riskFound = riskReasons(input, risk);

	const risky = riskFound.length > 0;

	const { ready_pr_min_confidence: ready, draft_pr_min_confidence: draft } =
		autonomy;

	const shown = confidence.toFixed(3);

	let delivery: GateResult["delivery"];

	let decision: string;

	if (confidence >= ready && !risky) {
		delivery = "ready_pr";
		decision = `Confidence ${shown} is at least ${ready} and nothing is risky: ready for review.`;
	} else if (confidence >= draft) {
		delivery = "draft_pr";
		decision =
			confidence >= ready
				? `Confidence ${shown} would be enough for review, but the change is risky: opened as a draft.`
				: `Confidence ${shown} is at least ${draft} but below ${ready}: opened as a draft.`;
	} else {
		delivery = "diagnosis_only";
		decision = `Confidence ${shown} is below ${draft}: no PR, the diagnosis is posted instead.`;
	}

	return {
		delivery,
		confidence,
		risky,
		reasons: [
			input.reproduced
				? "The bug was reproduced by a failing test."
				: "The bug was not reproduced.",
			input.targetGreen
				? "The target test passes."
				: "The target test does not pass.",
			input.suiteGreen
				? "The full suite passes."
				: "The full suite does not pass.",
			// Over the limit is listed with the risk reasons below.
			...(withinSizeLimit
				? [
						`The diff changes ${input.diffLines} lines, within the limit of ${risk.max_diff_lines}.`,
					]
				: []),
			...riskFound,
			decision,
		],
	};
}
