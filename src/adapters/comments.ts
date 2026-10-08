// Issue comment helpers beyond the status comment: marker-based upsert, and reading the
// reporter's answers to a needs-info question.
import type { Octokit } from "@octokit/rest";
import { NEEDS_INFO_MARKER } from "../notify/needsInfo.js";
import type { IssueInfo } from "../pipeline/run.js";
import { NEEDS_INFO_LABEL } from "../router.js";
import { STATUS_MARKER } from "../ui/statusComment.js";
import type { IssueRef } from "./github.js";

/** Replies are untrusted text that ends up in a prompt, so both the count and the size are capped. */
export const MAX_REPLIES = 5;

export const MAX_REPLY_CHARS = 2000;

async function listComments(octokit: Octokit, ref: IssueRef) {
	return octokit.paginate(octokit.issues.listComments, {
		owner: ref.owner,
		repo: ref.repo,
		issue_number: ref.issue,
		per_page: 100,
	});
}

/** Create a comment, or edit the one that already carries `marker`. Returns the comment id. */
export async function upsertMarkedComment(
	octokit: Octokit,
	ref: IssueRef,
	marker: string,
	body: string,
): Promise<number> {
	const existing = (await listComments(octokit, ref)).find((c) =>
		c.body?.includes(marker),
	);

	if (existing) {
		await octokit.issues.updateComment({
			owner: ref.owner,
			repo: ref.repo,
			comment_id: existing.id,
			body,
		});
		return existing.id;
	}

	const { data } = await octokit.issues.createComment({
		owner: ref.owner,
		repo: ref.repo,
		issue_number: ref.issue,
		body,
	});

	return data.id;
}

/**
 * The reporter's comments posted after FixLoop last wrote its status or needs-info comment.
 * FixLoop edits that comment in place, so "last wrote" is its update time, not its position.
 */
export async function repliesSince(
	octokit: Octokit,
	ref: IssueRef,
): Promise<string[]> {
	const [{ data: issue }, comments] = await Promise.all([
		octokit.issues.get({
			owner: ref.owner,
			repo: ref.repo,
			issue_number: ref.issue,
		}),
		listComments(octokit, ref),
	]);

	const reporter = issue.user?.login;

	if (!reporter) return [];

	// A reporter who pastes the marker into their own comment does not move the cut-off.
	const lastFixLoop = Math.max(
		0,
		...comments
			.filter(
				(c) =>
					c.user?.login !== reporter &&
					(c.body?.includes(STATUS_MARKER) ||
						c.body?.includes(NEEDS_INFO_MARKER)),
			)
			.map((c) => Date.parse(c.updated_at)),
	);

	return comments
		.filter(
			(c) =>
				c.user?.login === reporter &&
				Date.parse(c.created_at) > lastFixLoop &&
				c.body?.trim(),
		)
		.slice(-MAX_REPLIES)
		.map((c) => (c.body ?? "").trim().slice(0, MAX_REPLY_CHARS));
}

/** Sets the reporter's replies on the issue and clears the needs-info label, as a reply resumes the run. */
export async function resumeFromReplies(
	octokit: Octokit,
	ref: IssueRef,
	issue: IssueInfo,
): Promise<void> {
	issue.replies = await repliesSince(octokit, ref);

	try {
		await octokit.issues.removeLabel({
			owner: ref.owner,
			repo: ref.repo,
			issue_number: ref.issue,
			name: NEEDS_INFO_LABEL,
		});
	} catch (err) {
		// Already gone (for example, removed by hand) is the state we want.
		if ((err as { status?: number }).status !== 404) throw err;
	}

	issue.labels = issue.labels.filter((l) => l !== NEEDS_INFO_LABEL);
}

const RUN_LINE_RE = /run `(\d+)`/;

/** The run id on FixLoop's status comment (the line "run `<id>`"), or undefined when there is none. */
export function findRunId(bodies: string[]): string | undefined {
	for (const body of [...bodies].reverse()) {
		if (body.includes(STATUS_MARKER)) {
			const id = RUN_LINE_RE.exec(body)?.[1];

			if (id) return id;
		}
	}

	return undefined;
}

/**
 * Cancels the workflow run named on the issue's status comment, then says so on the issue. Only
 * bot comments count, so a commenter cannot point a stop at another run by pasting the marker.
 * Returns the comment it posted.
 */
export async function stopRun(
	octokit: Octokit,
	ref: IssueRef,
	actor: string,
	currentRunId?: string,
): Promise<string> {
	const comments = await listComments(octokit, ref);

	const runId = findRunId(
		comments
			.filter((c) => c.user?.login.endsWith("[bot]"))
			.map((c) => c.body ?? ""),
	);

	let message: string;

	if (!runId) {
		message = `FixLoop: stop requested by @${actor}, but no run is recorded on this issue.`;
	} else if (runId === currentRunId) {
		message = `FixLoop: stop requested by @${actor}, but run \`${runId}\` is this one.`;
	} else {
		try {
			await octokit.actions.cancelWorkflowRun({
				owner: ref.owner,
				repo: ref.repo,
				run_id: Number(runId),
			});
			message = `FixLoop: stop requested by @${actor}. Cancelling run \`${runId}\`.`;
		} catch (err) {
			message = `FixLoop: stop requested by @${actor}, but run \`${runId}\` could not be cancelled: ${(err as Error).message}`;
		}
	}

	await octokit.issues.createComment({
		owner: ref.owner,
		repo: ref.repo,
		issue_number: ref.issue,
		body: message,
	});

	return message;
}
