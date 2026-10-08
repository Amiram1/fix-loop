// Explains a run that reproduced the bug but did not end in a pull request, so a person can pick it up.
import type { Octokit } from "@octokit/rest";
import { upsertMarkedComment } from "../adapters/comments.js";
import type { IssueRef } from "../adapters/github.js";
import type {
	DeliverResult,
	FixResult,
	GateResult,
	Reproduction,
} from "../pipeline/artifacts.js";
import { fenced, inline } from "./text.js";

export const DIAGNOSIS_MARKER = "<!-- fixloop:diagnosis -->";

export interface DiagnosisInput {
	reproduction: Reproduction;
	/** Absent when the run ended before Fix. */
	fix?: FixResult;
	/** Absent when the fix was not accepted, so the gate never ran. */
	gate?: GateResult;
}

const MAX_HYPOTHESIS_LINES = 3;

const MAX_RAW_LINES = 8;

const MAX_REASONS = 4;

// Test-runner chatter that says nothing about why the test failed.
const NOISE = /^(=== (RUN|PAUSE|CONT)|exit status|FAIL\s|ok\s|PASS$)/;

const clip = (line: string) =>
	line.length > 200 ? `${line.slice(0, 200)}…` : line;

/** A line that says what failed: the failing test, an assertion, the values, or a source location. */
const SIGNAL =
	/--- FAIL|Error|expected|actual|got |want|received|assert|panic|\.go:\d+|\.ts:\d+/i;

/**
 * The lines that explain the failure. The first lines of a log are often setup, so the lines that
 * name a failure or a value come first. The first lines are used only when none of them match.
 */
function hypothesisLines(lines: string[]): string[] {
	const usable = lines.filter((l) => !NOISE.test(l.trim()));

	const signal = usable.filter((l) => SIGNAL.test(l));

	return (signal.length > 0 ? signal : usable)
		.slice(0, MAX_HYPOTHESIS_LINES)
		.map(clip);
}

export function renderDiagnosis({
	reproduction,
	fix,
	gate,
}: DiagnosisInput): string {
	const lines = (reproduction.evidence ?? "")
		.split("\n")
		.map((l) => l.trimEnd())
		.filter((l) => l.trim());

	const hypothesis = hypothesisLines(lines);

	const test = reproduction.testName
		? `The failing test ${inline(reproduction.testName)}${reproduction.testPath ? ` in ${inline(reproduction.testPath)}` : ""} fails with:`
		: "No failing test was kept. The run ended with:";

	const tried: string[] = [];

	if (fix) {
		tried.push(
			`- ${fix.attempts} fix attempt(s) with ${fix.models.join(", ") || "no model"} (cost $${fix.costUsd.toFixed(2)}).`,
		);
		tried.push(
			fix.status === "fixed"
				? `- A change touching ${fix.filesChanged.length} file(s) passed the failing test and the suite, but it was not delivered.`
				: `- No accepted fix. Last failure: ${inline(fix.reason ?? "no reason recorded", 300, "end")}`,
		);
	} else {
		tried.push("- No fix was attempted.");
	}

	const reasons = (gate?.reasons ?? [])
		.slice(0, MAX_REASONS)
		.map((r) => `- ${r.slice(0, 200)}`);

	const next = gate?.risky
		? "The change touches a risky area (or the issue is S1), so a person should make or review it."
		: fix?.status === "fixed"
			? "A candidate fix passed the tests but the gate did not trust it enough for a pull request. A person should review it."
			: "FixLoop could not get a change that passes both the failing test and the full suite.";

	return [
		DIAGNOSIS_MARKER,
		"### FixLoop · diagnosis, no pull request",
		"",
		"FixLoop reproduced this bug but did not open a pull request. Here is what it found.",
		"",
		"**Root-cause hypothesis**",
		test,
		...(hypothesis.length ? [fenced(hypothesis.join("\n"))] : []),
		"",
		"**What FixLoop tried**",
		...tried,
		...(reasons.length ? ["", "**Why no pull request**", ...reasons] : []),
		"",
		"**Next step**",
		`${next} Start from the failing test above. After adding detail to the issue, a collaborator can comment \`/fixloop retry\`.`,
		...(lines.length
			? [
					"",
					"<details><summary>Raw evidence</summary>",
					"",
					fenced(lines.slice(-MAX_RAW_LINES).map(clip).join("\n")),
					"</details>",
				]
			: []),
	].join("\n");
}

/** Posts the diagnosis as its own comment, edited in place if the run is repeated. */
export async function postDiagnosis(
	octokit: Octokit,
	ref: IssueRef,
	input: DiagnosisInput,
): Promise<DeliverResult> {
	const id = await upsertMarkedComment(
		octokit,
		ref,
		DIAGNOSIS_MARKER,
		renderDiagnosis(input),
	);

	return { status: "diagnosis_posted", detail: `comment ${id}` };
}
