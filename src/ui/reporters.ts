import type { Octokit } from "@octokit/rest";
import { type IssueRef, upsertStatusComment } from "../adapters/github.js";
import type { Reporter } from "../pipeline/run.js";
import { renderStatus } from "./statusComment.js";

export function githubReporter(octokit: Octokit, ref: IssueRef): Reporter {
	return {
		publish: async (view) => {
			await upsertStatusComment(octokit, ref, renderStatus(view));
		},
	};
}

/** Prints each status update to stdout. Used by `fixloop run --dry-run`. */
export function consoleReporter(
	write: (text: string) => void = console.log,
): Reporter {
	return {
		publish: async (view) => {
			write(renderStatus(view));
		},
	};
}
