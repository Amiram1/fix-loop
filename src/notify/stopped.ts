// Tells the reporter that the run ran out of budget, so the issue gets an answer and not a silent failure.
import type { Octokit } from "@octokit/rest";
import { upsertMarkedComment } from "../adapters/comments.js";
import type { IssueRef } from "../adapters/github.js";
import type { DeliverResult, StoppedInfo } from "../pipeline/artifacts.js";

export const STOPPED_MARKER = "<!-- fixloop:stopped -->";

/** Only numbers come in, so nothing untrusted reaches the comment. */
export function renderStopped({ spentUsd, limitUsd }: StoppedInfo): string {
	return [
		STOPPED_MARKER,
		`FixLoop stopped: the run budget ($${limitUsd.toFixed(2)}) was reached after $${spentUsd.toFixed(2)}. Nothing was pushed. A maintainer can run \`/fixloop retry\` to try again.`,
	].join("\n");
}

/** Posts the stopped comment as its own comment, edited in place if the run is repeated. */
export async function postStopped(
	octokit: Octokit,
	ref: IssueRef,
	input: StoppedInfo,
): Promise<DeliverResult> {
	const id = await upsertMarkedComment(
		octokit,
		ref,
		STOPPED_MARKER,
		renderStopped(input),
	);

	return { status: "stopped_posted", detail: `comment ${id}` };
}
