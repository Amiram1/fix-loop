import { Octokit } from "@octokit/rest";
import { STATUS_MARKER } from "../ui/statusComment.js";

export interface IssueRef {
  owner: string;
  repo: string;
  issue: number;
}

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

export async function hasLabels(octokit: Octokit, ref: IssueRef): Promise<string[]> {
  const { data } = await octokit.issues.get({ owner: ref.owner, repo: ref.repo, issue_number: ref.issue });
  return data.labels.map((l) => (typeof l === "string" ? l : l.name ?? ""));
}
