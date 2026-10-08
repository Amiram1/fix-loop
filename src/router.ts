// Maps a GitHub event payload to a FixLoop command. Pure: no I/O, so it's unit-tested directly.

export type Command =
	| { kind: "start"; issue: number; actor: string }
	| { kind: "retry"; issue: number; actor: string }
	| { kind: "stop"; issue: number; actor: string }
	/** A maintainer's note for a new run, like a retry with extra context. */
	| { kind: "hint"; issue: number; actor: string; text: string }
	/** A retry whose fix stage uses the escalation model and effort. */
	| { kind: "escalate"; issue: number; actor: string }
	/** A reviewer asked for changes on a FixLoop pull request: one more fix pass on its branch. */
	| {
			kind: "revise";
			prNumber: number;
			headRef: string;
			headSha: string;
			issue: number;
			text: string;
	  }
	/** The reporter answered a needs-info question. */
	| { kind: "reply"; issue: number; actor: string }
	/** A FixLoop pull request was closed. Not a run: it only updates the ledger. */
	| { kind: "outcome"; prNumber: number; merged: boolean; title: string }
	| { kind: "ignore"; reason: string };

export interface RoutableEvent {
	name: string;
	action?: string;
	// biome-ignore lint/suspicious/noExplicitAny: webhook payloads are untyped JSON
	payload: Record<string, any>;
}

export const NEEDS_INFO_LABEL = "needs-info";

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

const COMMAND_RE = /^\s*\/fixloop\s+(retry|stop|escalate)\b/m;

/** A hint starts the comment; everything after the command is the hint. */
const HINT_RE = /^\s*\/fixloop\s+hint\b([\s\S]*)$/;

/** Comment and review text ends up in a prompt, so its size is capped. */
const MAX_TEXT = 2000;

const BRANCH_ISSUE_RE = /^fixloop\/issue-(\d+)$/;

const NO_REVIEW_TEXT = "The reviewer requested changes without a comment.";

export function route(event: RoutableEvent): Command {
	const { payload } = event;

	if (event.name === "issues" && event.action === "opened") {
		if (payload.issue?.pull_request)
			return { kind: "ignore", reason: "pull request" };

		return {
			kind: "start",
			issue: payload.issue.number,
			actor: payload.sender.login,
		};
	}

	if (event.name === "issue_comment" && event.action === "created") {
		if (payload.issue?.pull_request)
			return { kind: "ignore", reason: "comment on pull request" };

		const body: string = payload.comment?.body ?? "";

		const hint = HINT_RE.exec(body);

		const match = hint ? undefined : COMMAND_RE.exec(body);

		if (!hint && !match) {
			// Not a command: it only matters as the reporter's answer to a needs-info question.
			const labels: unknown[] = payload.issue?.labels ?? [];

			const asked = labels.some(
				(l) =>
					(typeof l === "string"
						? l
						: (l as { name?: string } | null)?.name) ===
					NEEDS_INFO_LABEL,
			);

			const author: string | undefined = payload.issue?.user?.login;

			if (asked && author && payload.sender?.login === author) {
				return {
					kind: "reply",
					issue: payload.issue.number,
					actor: author,
				};
			}

			return { kind: "ignore", reason: "not a fixloop command" };
		}

		const association: string =
			payload.comment.author_association ?? "NONE";

		if (!TRUSTED_ASSOCIATIONS.has(association)) {
			return {
				kind: "ignore",
				reason: `command from untrusted author (${association})`,
			};
		}

		const who = {
			issue: payload.issue.number,
			actor: payload.sender.login,
		};

		if (hint) {
			const text = (hint[1] ?? "").trim().slice(0, MAX_TEXT);

			return text
				? { kind: "hint", ...who, text }
				: { kind: "ignore", reason: "hint without text" };
		}

		return { kind: match?.[1] as "retry" | "stop" | "escalate", ...who };
	}

	if (event.name === "pull_request_review" && event.action === "submitted") {
		const { pull_request: pr, review } = payload;

		const issue = BRANCH_ISSUE_RE.exec(String(pr?.head?.ref))?.[1];

		if (
			String(review?.state).toLowerCase() !== "changes_requested" ||
			!issue
		) {
			return { kind: "ignore", reason: "not a fixloop change request" };
		}

		// A fork's branch can share the name of one of ours, and its commits are not ours to build on.
		if (pr.head.repo?.full_name !== pr.base?.repo?.full_name)
			return { kind: "ignore", reason: "pull request from a fork" };

		const association: string = review.author_association ?? "NONE";

		if (!TRUSTED_ASSOCIATIONS.has(association)) {
			return {
				kind: "ignore",
				reason: `review from untrusted author (${association})`,
			};
		}

		return {
			kind: "revise",
			prNumber: pr.number,
			headRef: pr.head.ref,
			headSha: pr.head.sha,
			issue: Number(issue),
			text:
				String(review.body ?? "")
					.trim()
					.slice(0, MAX_TEXT) || NO_REVIEW_TEXT,
		};
	}

	if (event.name === "pull_request" && event.action === "closed") {
		const pr = payload.pull_request;

		const ref = String(pr?.head?.ref);

		// GitHub's default branch for a revert is `revert-<n>-<name>`, and its title is `Revert "<title>"`.
		const revert =
			ref.startsWith("revert-") &&
			String(pr?.title).startsWith('Revert "');

		if (!ref.startsWith("fixloop/") && !revert)
			return { kind: "ignore", reason: "not a fixloop pull request" };

		return {
			kind: "outcome",
			prNumber: pr.number,
			merged: pr.merged === true,
			title: pr.title ?? "",
		};
	}

	return {
		kind: "ignore",
		reason: `unhandled event ${event.name}${event.action ? `.${event.action}` : ""}`,
	};
}
