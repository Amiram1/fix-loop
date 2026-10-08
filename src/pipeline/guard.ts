// Decides whether a routed command may start work. Pure; labels are passed in by the caller.

import type { Command } from "../router.js";

export interface GuardInput {
  command: Command;
  labels: string[];
  /** Whether the run should only proceed if no other FixLoop run is active for this issue. */
  activeRunForIssue: boolean;
}

export type GuardResult = { allowed: true } | { allowed: false; reason: string };

export const SKIP_LABEL = "fixloop:skip";

export function guard({ command, labels, activeRunForIssue }: GuardInput): GuardResult {
  if (command.kind === "ignore") return { allowed: false, reason: command.reason };
  if (labels.includes(SKIP_LABEL)) return { allowed: false, reason: `issue has ${SKIP_LABEL}` };
  if (command.kind === "start" && activeRunForIssue) {
    return { allowed: false, reason: "a run is already active for this issue" };
  }
  if (command.kind === "stop" && !activeRunForIssue) {
    return { allowed: false, reason: "no active run to stop" };
  }
  return { allowed: true };
}
