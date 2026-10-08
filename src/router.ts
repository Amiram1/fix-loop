// Maps a GitHub event payload to a FixLoop command. Pure: no I/O, so it's unit-tested directly.

export type Command =
	| { kind: "start"; issue: number; actor: string }
	| { kind: "retry"; issue: number; actor: string }
	| { kind: "stop"; issue: number; actor: string }
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

const COMMAND_RE = /^\s*\/fixloop\s+(retry|stop)\b/m;

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

		const match = COMMAND_RE.exec(body);

		if (!match) {
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

		const kind = match[1] as "retry" | "stop";

		return {
			kind,
			issue: payload.issue.number,
			actor: payload.sender.login,
		};
	}

	if (event.name === "pull_request" && event.action === "closed") {
		const pr = payload.pull_request;

		if (!String(pr?.head?.ref).startsWith("fixloop/"))
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
