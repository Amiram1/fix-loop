import type { Octokit } from "@octokit/rest";
import type { OpenIssue } from "../pipeline/intake.js";
import type { IssueInfo } from "../pipeline/run.js";
import { STATUS_MARKER } from "../ui/statusComment.js";

export interface IssueRef {
	owner: string;
	repo: string;
	issue: number;
}

/** A repository, for calls that are not about one issue (labels, branches, pull requests). */
export type RepoRef = Pick<IssueRef, "owner" | "repo">;

/** Create the status comment, or edit the existing one (found by marker). Returns the comment id. */
export async function upsertStatusComment(
	octokit: Octokit,
	ref: IssueRef,
	body: string,
): Promise<number> {
	const comments = await octokit.paginate(octokit.issues.listComments, {
		owner: ref.owner,
		repo: ref.repo,
		issue_number: ref.issue,
		per_page: 100,
	});

	const existing = comments.find((c) => c.body?.includes(STATUS_MARKER));

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

export async function fetchIssue(
	octokit: Octokit,
	ref: IssueRef,
): Promise<IssueInfo> {
	const { data } = await octokit.issues.get({
		owner: ref.owner,
		repo: ref.repo,
		issue_number: ref.issue,
	});

	return {
		number: data.number,
		title: data.title,
		body: data.body ?? "",
		labels: data.labels.map((l) =>
			typeof l === "string" ? l : (l.name ?? ""),
		),
		issueCreatedAt: data.created_at,
	};
}

/** The slice of an issue comment that human-touch counting reads. */
export interface CommentLike {
	user?: { login: string } | null;
	created_at: string;
}

const isBot = (login: string) =>
	login.endsWith("[bot]") || login.toLowerCase() === "github-actions";

/**
 * How many comments are from people (not bots) and were created at or after `since`. A reply from
 * the reporter counts, and so does a /fixloop command from a maintainer.
 */
export function countHumanComments(
	comments: CommentLike[],
	since: string,
): number {
	const from = Date.parse(since);

	return comments.filter(
		(c) => Date.parse(c.created_at) >= from && !isBot(c.user?.login ?? ""),
	).length;
}

/** Human comments on the issue since `since` (ISO): the run's human touches. */
export async function countHumanTouches(
	octokit: Octokit,
	ref: IssueRef,
	since: string,
): Promise<number> {
	// GitHub's `since` filters on update time, which is never before creation: no new comment is missed.
	const comments = await octokit.paginate(octokit.issues.listComments, {
		owner: ref.owner,
		repo: ref.repo,
		issue_number: ref.issue,
		since,
		per_page: 100,
	});

	return countHumanComments(comments, since);
}

/** The most recently updated open issues, without pull requests. One page only: the caller caps `limit`. */
export async function listOpenIssues(
	octokit: Octokit,
	ref: IssueRef,
	limit: number,
): Promise<OpenIssue[]> {
	const { data } = await octokit.issues.listForRepo({
		owner: ref.owner,
		repo: ref.repo,
		state: "open",
		per_page: Math.min(limit, 100),
	});

	return data
		.filter((issue) => !issue.pull_request)
		.slice(0, limit)
		.map((issue) => ({ number: issue.number, title: issue.title }));
}
