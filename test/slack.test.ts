import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config/load.js";
import {
	buildSlackMessage,
	meetsSeverity,
	notifyAfterRun,
	postSlack,
	slackEventsFor,
} from "../src/notify/slack.js";
import type { RunArtifacts, Severity } from "../src/pipeline/artifacts.js";
import type { RunContext } from "../src/pipeline/run.js";

const URL_SECRET = "https://hooks.slack.com/services/T000/B000/SECRETSECRET";

const BASE =
	"app:\n  up: x\n  base_url: http://localhost:3456\ntests:\n  full: 'true'\n";

const config = parseConfig(
	`${BASE}notify:\n  slack:\n    min_severity: S2\n    on: [escalation, pr_ready]\n`,
);

const links = { issue: "https://github.com/o/r/issues/4" };

function ctxWith(artifacts: RunArtifacts, title = "Tasks vanish"): RunContext {
	return {
		runId: "r1",
		config,
		issue: { number: 4, title, body: "", labels: [] },
		dryRun: false,
		artifacts,
	};
}

const intake = (severity: Severity): RunArtifacts["intake"] => ({
	area: "backend",
	severity,
	summary: "s",
	injectionSuspected: false,
});

const needsInfo = (severity: Severity = "S2"): RunArtifacts => ({
	intake: intake(severity),
	delivery: { status: "needs_info_posted", detail: "comment 1" },
});

const prRun = (delivery: "ready_pr" | "draft_pr"): RunArtifacts => ({
	intake: intake("S2"),
	gate: { delivery, confidence: 0.9, risky: false, reasons: [] },
	delivery: {
		status: "pr_opened",
		url: "https://github.com/o/r/pull/9",
		detail: "PR #9 opened as ready for review.\nmore",
	},
});

const okFetch = () => vi.fn(async () => new Response("ok", { status: 200 }));

describe("meetsSeverity", () => {
	const order: Severity[] = ["S1", "S2", "S3", "S4"];

	it.each(
		order.flatMap((s, i) =>
			order.map((min, j) => [s, min, i <= j] as const),
		),
	)("%s against min %s is %s", (severity, min, expected) => {
		expect(meetsSeverity(severity, min)).toBe(expected);
	});

	it("never passes a run without a severity", () => {
		expect(meetsSeverity(undefined, "S4")).toBe(false);
	});
});

describe("slackEventsFor", () => {
	it("calls needs-info and diagnosis escalations", () => {
		expect(slackEventsFor(ctxWith(needsInfo()))).toEqual(["escalation"]);
		expect(
			slackEventsFor(
				ctxWith({ delivery: { status: "diagnosis_posted" } }),
			),
		).toEqual(["escalation"]);
	});

	it("calls a ready PR pr_ready", () => {
		expect(slackEventsFor(ctxWith(prRun("ready_pr")))).toEqual([
			"pr_ready",
		]);
	});

	it("does not call a draft PR pr_ready", () => {
		expect(slackEventsFor(ctxWith(prRun("draft_pr")))).toEqual([]);
	});

	it("calls a stopped run an escalation", () => {
		const ctx = ctxWith({ intake: intake("S1") });

		Object.assign(ctx.artifacts, { stopped: { reason: "budget spent" } });
		expect(slackEventsFor(ctx)).toEqual(["escalation"]);
	});

	it("has no events for an empty run", () => {
		expect(slackEventsFor(ctxWith({}))).toEqual([]);
	});
});

describe("buildSlackMessage", () => {
	it("renders a ready PR", () => {
		const { text } = buildSlackMessage(
			ctxWith(prRun("ready_pr")),
			"pr_ready",
			links,
			0.1234,
		);

		expect(text).toBe(
			[
				"*Ready for review*",
				"#4: Tasks vanish",
				"Severity: S2",
				"PR #9 opened as ready for review.",
				"Issue: https://github.com/o/r/issues/4",
				"PR: https://github.com/o/r/pull/9",
				"Cost: $0.12",
			].join("\n"),
		);
	});

	it("labels an escalation and a stopped run differently", () => {
		const asked = buildSlackMessage(
			ctxWith(needsInfo()),
			"escalation",
			links,
		);

		expect(asked.text.split("\n")[0]).toBe("*Needs a human*");

		const stopped = ctxWith({ intake: intake("S1") });

		Object.assign(stopped.artifacts, {
			stopped: { reason: "budget spent" },
		});

		const { text } = buildSlackMessage(stopped, "escalation", links);

		expect(text.split("\n")[0]).toBe("*Stopped*");
		expect(text).toContain("budget spent");
	});

	it("escapes Slack control characters and neutralises @", () => {
		const { text } = buildSlackMessage(
			ctxWith(needsInfo(), "a <!channel> & b @here"),
			"escalation",
			links,
		);

		expect(text).toContain("a &lt;!channel&gt; &amp; b ＠here");
		expect(text).not.toContain("<");
		expect(text).not.toContain("@");
	});

	it("caps a long title and the whole message", () => {
		const { text } = buildSlackMessage(
			ctxWith(needsInfo(), "x".repeat(5000)),
			"escalation",
			links,
		);

		expect(text.split("\n")[1]?.length).toBeLessThanOrEqual(130);
		expect(text.length).toBeLessThan(600);

		const nasty = buildSlackMessage(
			ctxWith(needsInfo(), "&".repeat(5000)),
			"escalation",
			links,
		);

		expect(nasty.text.length).toBeLessThanOrEqual(600);
	});

	it("has no webhook URL in it", () => {
		const { text } = buildSlackMessage(
			ctxWith(needsInfo()),
			"escalation",
			links,
		);

		expect(text).not.toContain("hooks.slack.com");
	});
});

describe("postSlack", () => {
	it("posts JSON to the webhook", async () => {
		const fetchImpl = okFetch();

		expect(await postSlack(URL_SECRET, { text: "hi" }, fetchImpl)).toEqual({
			ok: true,
			status: 200,
		});

		const [url, init] = fetchImpl.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];

		expect(url).toBe(URL_SECRET);
		expect(init.method).toBe("POST");
		expect(init.body).toBe('{"text":"hi"}');
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("reports an HTTP error and a network error without throwing", async () => {
		const failing = vi.fn(async () => new Response("no", { status: 500 }));

		expect(await postSlack(URL_SECRET, { text: "hi" }, failing)).toEqual({
			ok: false,
			status: 500,
		});

		const down = vi.fn(async () => {
			throw new Error(`connect ECONNREFUSED ${URL_SECRET}`);
		});

		expect(await postSlack(URL_SECRET, { text: "hi" }, down)).toEqual({
			ok: false,
			status: 0,
		});
	});
});

describe("notifyAfterRun", () => {
	const run = (
		over: Partial<Parameters<typeof notifyAfterRun>[0]> & {
			ctx: RunContext;
		},
	) => notifyAfterRun({ config, webhookUrl: URL_SECRET, links, ...over });

	it("sends nothing without a webhook", async () => {
		const fetchImpl = okFetch();

		const lines = await run({
			ctx: ctxWith(needsInfo()),
			webhookUrl: undefined,
			fetchImpl,
		});

		expect(lines).toEqual([]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("sends nothing without notify.slack config", async () => {
		const fetchImpl = okFetch();

		const lines = await run({
			ctx: ctxWith(needsInfo()),
			config: parseConfig(BASE),
			fetchImpl,
		});

		expect(lines).toEqual([]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("sends once for an event that passes", async () => {
		const fetchImpl = okFetch();

		const lines = await run({ ctx: ctxWith(needsInfo("S1")), fetchImpl });

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(lines).toEqual(["slack: sent escalation (S1)"]);
	});

	it("skips a severity that does not pass", async () => {
		const fetchImpl = okFetch();

		const lines = await run({ ctx: ctxWith(needsInfo("S3")), fetchImpl });

		expect(fetchImpl).not.toHaveBeenCalled();
		expect(lines).toEqual([
			"slack: skipped escalation (severity S3 is below S2)",
		]);
	});

	it("skips an event that is not in `on`, and a run with no severity", async () => {
		const fetchImpl = okFetch();

		const onlyEscalation = parseConfig(
			`${BASE}notify:\n  slack:\n    on: [escalation]\n`,
		);

		const skipped = await run({
			ctx: ctxWith(prRun("ready_pr")),
			config: onlyEscalation,
			fetchImpl,
		});

		const unranked = await run({
			ctx: ctxWith({ delivery: { status: "needs_info_posted" } }),
			fetchImpl,
		});

		expect(fetchImpl).not.toHaveBeenCalled();
		expect(skipped).toEqual([
			"slack: skipped pr_ready (not in notify.slack.on)",
		]);
		expect(unranked).toEqual([
			"slack: skipped escalation (severity unknown is below S2)",
		]);
	});

	it("reports a 500 without throwing, and no line has the URL", async () => {
		const fetchImpl = vi.fn(
			async () => new Response("no", { status: 500 }),
		);

		const lines = await run({ ctx: ctxWith(needsInfo()), fetchImpl });

		expect(lines).toEqual(["slack: escalation not delivered (HTTP 500)"]);

		for (const line of lines) expect(line).not.toContain("hooks.slack.com");
	});
});
