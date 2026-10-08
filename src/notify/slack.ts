// Outbound Slack notifications through an incoming webhook (PLAN.md section 7). One short message
// per run, only for runs a human should look at, and only at or above the configured severity.
// The webhook URL is a secret: it is never put in a message, a result or an error.
import type { FixLoopConfig } from "../config/schema.js";
import type { Severity } from "../pipeline/artifacts.js";
import type { RunContext } from "../pipeline/run.js";

export type SlackEvent = "escalation" | "pr_ready";

export interface SlackLinks {
	issue: string;
	/** Defaults to the URL Deliver recorded. */
	pr?: string;
}

export interface SlackResult {
	ok: boolean;
	/** HTTP status, or 0 when no response arrived (network error or timeout). */
	status: number;
}

const RANK: Record<Severity, number> = { S1: 1, S2: 2, S3: 3, S4: 4 };

const TITLE_MAX = 120;

const OUTCOME_MAX = 160;

const MESSAGE_MAX = 600;

const TIMEOUT_MS = 10_000;

/** The fields another stage adds when a run is cut short. Read defensively, its shape is not fixed here. */
function stoppedOf(ctx: RunContext): unknown {
	return (ctx.artifacts as { stopped?: unknown }).stopped;
}

/** What this run produced that a human may want to hear about. */
export function slackEventsFor(ctx: RunContext): SlackEvent[] {
	const { delivery, gate } = ctx.artifacts;

	const events: SlackEvent[] = [];

	if (
		delivery?.status === "needs_info_posted" ||
		delivery?.status === "diagnosis_posted" ||
		stoppedOf(ctx)
	) {
		events.push("escalation");
	}

	if (
		(delivery?.status === "pr_opened" ||
			delivery?.status === "pr_updated") &&
		gate?.delivery === "ready_pr"
	) {
		events.push("pr_ready");
	}

	return events;
}

/** S1 is the most severe: a severity passes when it ranks at or above `min`. No severity never passes. */
export function meetsSeverity(
	severity: Severity | undefined,
	min: Severity,
): boolean {
	return severity !== undefined && RANK[severity] <= RANK[min];
}

/** One line, cut to `max`, with Slack's control characters escaped and "@" replaced so nobody is pinged. */
function defuse(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();

	const cut = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;

	return cut
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll("@", "＠");
}

const OUTCOME: Record<string, string> = {
	needs_info_posted:
		"Not reproduced, so I asked the reporter for more information.",
	diagnosis_posted:
		"Reproduced, but no fix is safe to propose; the diagnosis is on the issue.",
};

/** The Slack text for one event. `spentUsd` is the budget total; without it the stages' own costs are summed. */
export function buildSlackMessage(
	ctx: RunContext,
	event: SlackEvent,
	links: SlackLinks,
	spentUsd?: number,
): { text: string } {
	const { intake, delivery, reproduction, fix } = ctx.artifacts;

	const stopped = stoppedOf(ctx);

	const stoppedWhy =
		(stopped as { reason?: unknown } | null)?.reason ?? stopped;

	const title =
		event === "pr_ready"
			? "Ready for review"
			: stopped
				? "Stopped"
				: "Needs a human";

	const outcome =
		(typeof stoppedWhy === "string" ? stoppedWhy : undefined) ||
		OUTCOME[delivery?.status ?? ""] ||
		delivery?.detail?.split("\n")[0] ||
		"Done.";

	const cost = spentUsd ?? (reproduction?.costUsd ?? 0) + (fix?.costUsd ?? 0);

	const pr = links.pr ?? delivery?.url;

	const lines = [
		`*${title}*`,
		`#${ctx.issue.number}: ${defuse(ctx.issue.title, TITLE_MAX)}`,
		`Severity: ${intake?.severity ?? "unknown"}`,
		defuse(outcome, OUTCOME_MAX),
		`Issue: ${defuse(links.issue, 200)}`,
		...(pr ? [`PR: ${defuse(pr, 200)}`] : []),
		`Cost: $${cost.toFixed(2)}`,
	];

	return { text: lines.join("\n").slice(0, MESSAGE_MAX) };
}

/** POSTs one message. Never throws and never reports the URL: a failure is `ok: false`. */
export async function postSlack(
	webhookUrl: string,
	body: { text: string },
	fetchImpl: typeof fetch = fetch,
): Promise<SlackResult> {
	try {
		const res = await fetchImpl(webhookUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});

		return { ok: res.ok, status: res.status };
	} catch {
		// The error text can carry the URL, so it is dropped.
		return { ok: false, status: 0 };
	}
}

export interface NotifyInput {
	ctx: RunContext;
	config: FixLoopConfig;
	webhookUrl?: string;
	fetchImpl?: typeof fetch;
	links: SlackLinks;
	spentUsd?: number;
}

/** Sends what the config asks for. Returns one line per event saying what happened; no line has the URL. */
export async function notifyAfterRun(input: NotifyInput): Promise<string[]> {
	const { ctx, config, webhookUrl, fetchImpl, links, spentUsd } = input;

	const slack = config.notify.slack;

	if (!webhookUrl || !slack) return [];

	const severity = ctx.artifacts.intake?.severity;

	const lines: string[] = [];

	for (const event of slackEventsFor(ctx)) {
		if (!slack.on.includes(event)) {
			lines.push(`slack: skipped ${event} (not in notify.slack.on)`);
			continue;
		}

		if (!meetsSeverity(severity, slack.min_severity)) {
			lines.push(
				`slack: skipped ${event} (severity ${severity ?? "unknown"} is below ${slack.min_severity})`,
			);
			continue;
		}

		const sent = await postSlack(
			webhookUrl,
			buildSlackMessage(ctx, event, links, spentUsd),
			fetchImpl,
		);

		lines.push(
			sent.ok
				? `slack: sent ${event} (${severity})`
				: `slack: ${event} not delivered (${sent.status ? `HTTP ${sent.status}` : "no response"})`,
		);
	}

	return lines;
}
