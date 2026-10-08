// Asks the reporter for what a reproduction needs when the run could not reproduce the bug.
// The question is the issue's single status comment, so it is found and edited in place.
import type { Octokit } from "@octokit/rest";
import { type IssueRef, upsertStatusComment } from "../adapters/github.js";
import type { DeliverResult } from "../pipeline/artifacts.js";
import { NEEDS_INFO_LABEL } from "../router.js";
import { STATUS_MARKER } from "../ui/statusComment.js";
import { inline } from "./text.js";

export { NEEDS_INFO_LABEL };

/** Second marker inside the status comment, so the question can be told apart from a progress update. */
export const NEEDS_INFO_MARKER = "<!-- fixloop:needs-info -->";

export interface NeedsInfoInput {
	/** Why Reproduce stopped. Accepts the stage detail ("not reproduced: ...") or the bare reason. */
	reason: string;
	title: string;
}

// Extra questions for the failures where a specific answer is what is missing.
const FOLLOW_UPS: [RegExp, string][] = [
	[
		/runner for area|area "/i,
		"Does the problem happen in the web interface or in the API (server)?",
	],
	[
		/timed out|locator|\bpage\b|login|navigat|\burl\b|unreachable|ECONNREFUSED|could not reach/i,
		"Which page or screen were you on, what was its URL, and which user (and role) were you logged in as?",
	],
	[
		/passed|does not show the bug/i,
		"Which exact values or data triggered it? A test with ordinary data passed, so it probably needs a specific input or state.",
	],
];

export function renderNeedsInfo({ reason, title }: NeedsInfoInput): string {
	const why = reason.replace(/^not reproduced:\s*/i, "");

	const extra = FOLLOW_UPS.filter(([re]) => re.test(why))
		.slice(0, 2)
		.map(([, q]) => q);

	return [
		STATUS_MARKER,
		NEEDS_INFO_MARKER,
		"### FixLoop · needs more information",
		"",
		`I could not reproduce ${inline(title, 120)} from the report, so I have not tried a fix.`,
		`What stopped me: ${inline(why, 300)}`,
		"",
		"Could you reply on this issue with:",
		"1. The steps to reproduce, starting from a fresh state, as exact as you can.",
		"2. What you expected to happen and what happened instead (error text or a screenshot).",
		"3. Your environment: version or commit, browser or OS, and any settings or data that matter.",
		...extra.map((q, i) => `${4 + i}. ${q}`),
		"",
		`When you reply, FixLoop picks the run up again and removes the \`${NEEDS_INFO_LABEL}\` label.`,
	].join("\n");
}

/** Posts the question as the status comment and labels the issue, creating the label if it is missing. */
export async function postNeedsInfo(
	octokit: Octokit,
	ref: IssueRef,
	input: NeedsInfoInput,
): Promise<DeliverResult> {
	const id = await upsertStatusComment(octokit, ref, renderNeedsInfo(input));

	const { owner, repo } = ref;

	try {
		await octokit.issues.getLabel({ owner, repo, name: NEEDS_INFO_LABEL });
	} catch (err) {
		if ((err as { status?: number }).status !== 404) throw err;

		await octokit.issues.createLabel({
			owner,
			repo,
			name: NEEDS_INFO_LABEL,
			color: "d876e3",
			description: "FixLoop needs more information from the reporter",
		});
	}

	await octokit.issues.addLabels({
		owner,
		repo,
		issue_number: ref.issue,
		labels: [NEEDS_INFO_LABEL],
	});

	return { status: "needs_info_posted", detail: `comment ${id}` };
}
