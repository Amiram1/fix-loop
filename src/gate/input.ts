import type { Severity } from "../pipeline/artifacts.js";
import type { RunContext } from "../pipeline/run.js";

/** The measured signals the gate decides from. */
export interface GateInput {
	/** A test failed for the reported bug before the fix. */
	reproduced: boolean;
	/** The red test passes after the fix. */
	targetGreen: boolean;
	/** The full suite passes after the fix. */
	suiteGreen: boolean;
	/** Added plus removed lines in the fix diff. */
	diffLines: number;
	filesChanged: string[];
	severity: Severity;
	/** The issue title and body, for the keywords that corroborate an S1. Only searched, never shown. */
	issueText?: string;
}

/**
 * Added and removed lines in a unified diff. Only lines inside a hunk count, so the `---` and `+++`
 * file headers are skipped, while a removed line whose text starts with `--` (an SQL comment) still counts.
 */
export function countDiffLines(diff: string): number {
	let inHunk = false;

	let count = 0;

	for (const line of diff.split("\n")) {
		if (line.startsWith("diff --git ")) inHunk = false;
		else if (line.startsWith("@@")) inHunk = true;
		else if (inHunk && (line.startsWith("+") || line.startsWith("-")))
			count++;
	}

	return count;
}

/**
 * Builds the gate input from what earlier stages left on the context. A missing artifact gives the
 * conservative value: not reproduced, not green, no diff, and S1.
 * A fixed run has already passed the target test and the full suite, so both come from `fix.status`.
 */
export function gateInputFrom(ctx: RunContext): GateInput {
	const { intake, reproduction, fix } = ctx.artifacts;

	const fixed = fix?.status === "fixed";

	return {
		reproduced: reproduction?.status === "reproduced",
		targetGreen: fixed,
		suiteGreen: fixed,
		diffLines: fix ? countDiffLines(fix.diff) : 0,
		filesChanged: fix?.filesChanged ?? [],
		severity: intake?.severity ?? "S1",
		issueText: `${ctx.issue.title}\n${ctx.issue.body}`,
	};
}
