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
	};
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
