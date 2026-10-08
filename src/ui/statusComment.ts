// One status comment per issue, edited in place. Found again via a hidden marker.

export const STATUS_MARKER = "<!-- fixloop:status -->";

export type StageState = "pending" | "running" | "done" | "skipped" | "failed";

export interface StatusView {
  runId: string;
  headline: string;
  stages: { name: string; state: StageState; detail?: string }[];
}

const ICON: Record<StageState, string> = {
  pending: "⬜",
  running: "🔄",
  done: "✅",
  skipped: "⏭️",
  failed: "❌",
};

export function renderStatus(view: StatusView): string {
  const rows = view.stages.map(
    (s) => `- ${ICON[s.state]} **${s.name}**${s.detail ? ` — ${s.detail}` : ""}`,
  );
  return [
    STATUS_MARKER,
    `### FixLoop · ${view.headline}`,
    "",
    ...rows,
    "",
    `<sub>run \`${view.runId}\`</sub>`,
  ].join("\n");
}
