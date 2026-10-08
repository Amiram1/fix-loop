import type { Octokit } from "@octokit/rest";
import type { RepoRef } from "./github.js";

export interface PullSpec {
	/** Branch in the same repo that holds the change. */
	branch: string;
	base: string;
	title: string;
	body: string;
	draft: boolean;
	labels: string[];
	/** GitHub login to request a review from. */
	reviewer?: string;
}

export interface PullOutcome {
	status: "pr_opened" | "pr_updated";
	number: number;
	url: string;
	/** Things the caller should tell the user: a failed reviewer request, a draft state left as it was. */
	notes: string[];
}

/**
 * Opens the PR for the branch, or updates the open one: there is never a second PR for a branch.
 * Updating changes the title, body and labels only. GitHub's REST API cannot flip a PR between
 * draft and ready, so an existing PR keeps its state and a note says so.
 * A failed reviewer request is a note, not an error: the PR is already open.
 */
export async function upsertPullRequest(
	octokit: Octokit,
	repo: RepoRef,
	spec: PullSpec,
): Promise<PullOutcome> {
	const notes: string[] = [];

	const { data: open } = await octokit.pulls.list({
		...repo,
		state: "open",
		head: `${repo.owner}:${spec.branch}`,
		per_page: 1,
	});

	const found = open[0];

	let number: number;

	let url: string;

	if (found) {
		await octokit.pulls.update({
			...repo,
			pull_number: found.number,
			title: spec.title,
			body: spec.body,
		});
		number = found.number;
		url = found.html_url;

		if (Boolean(found.draft) !== spec.draft) {
			notes.push(
				`The open PR stays ${found.draft ? "a draft" : "ready for review"}; the gate now says ${spec.draft ? "draft" : "ready"}.`,
			);
		}
	} else {
		const { data } = await octokit.pulls.create({
			...repo,
			head: spec.branch,
			base: spec.base,
			title: spec.title,
			body: spec.body,
			draft: spec.draft,
		});

		number = data.number;
		url = data.html_url;
	}

	await octokit.issues.addLabels({
		...repo,
		issue_number: number,
		labels: spec.labels,
	});

	if (spec.reviewer) {
		try {
			await octokit.pulls.requestReviewers({
				...repo,
				pull_number: number,
				reviewers: [spec.reviewer],
			});
		} catch (err) {
			notes.push(
				`Could not request a review from @${spec.reviewer}: ${(err as Error).message}`,
			);
		}
	}

	return { status: found ? "pr_updated" : "pr_opened", number, url, notes };
}
