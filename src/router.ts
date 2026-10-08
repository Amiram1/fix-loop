// Maps a GitHub event payload to a FixLoop command. Pure: no I/O, so it's unit-tested directly.

export type Command =
  | { kind: "start"; issue: number; actor: string }
  | { kind: "retry"; issue: number; actor: string }
  | { kind: "stop"; issue: number; actor: string }
  | { kind: "ignore"; reason: string };

export interface RoutableEvent {
  name: string;
  action?: string;
  payload: Record<string, any>;
}

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const COMMAND_RE = /^\s*\/fixloop\s+(retry|stop)\b/m;

export function route(event: RoutableEvent): Command {
  const { payload } = event;

  if (event.name === "issues" && event.action === "opened") {
    if (payload.issue?.pull_request) return { kind: "ignore", reason: "pull request" };
    return { kind: "start", issue: payload.issue.number, actor: payload.sender.login };
  }

  if (event.name === "issue_comment" && event.action === "created") {
    if (payload.issue?.pull_request) return { kind: "ignore", reason: "comment on pull request" };
    const body: string = payload.comment?.body ?? "";
    const match = COMMAND_RE.exec(body);
    if (!match) return { kind: "ignore", reason: "not a fixloop command" };
    const association: string = payload.comment.author_association ?? "NONE";
    if (!TRUSTED_ASSOCIATIONS.has(association)) {
      return { kind: "ignore", reason: `command from untrusted author (${association})` };
    }
    const kind = match[1] as "retry" | "stop";
    return { kind, issue: payload.issue.number, actor: payload.sender.login };
  }

  return { kind: "ignore", reason: `unhandled event ${event.name}${event.action ? `.${event.action}` : ""}` };
}
