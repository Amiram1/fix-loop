import { describe, expect, it } from "vitest";
import { guard } from "../src/pipeline/guard.js";
import { route } from "../src/router.js";
import { renderStatus, STATUS_MARKER } from "../src/ui/statusComment.js";

// biome-ignore lint/suspicious/noExplicitAny: webhook payloads are untyped JSON
const issueOpened = (extra: Record<string, any> = {}) => ({
	name: "issues",
	action: "opened",
	payload: { issue: { number: 7 }, sender: { login: "reporter" }, ...extra },
});

describe("route", () => {
	it("starts a run on issue opened", () => {
		expect(route(issueOpened())).toEqual({
			kind: "start",
			issue: 7,
			actor: "reporter",
		});
	});

	it("ignores pull requests", () => {
		const r = route(
			issueOpened({ issue: { number: 7, pull_request: {} } }),
		);

		expect(r.kind).toBe("ignore");
	});

	it("accepts retry/stop from collaborators only", () => {
		const comment = (association: string, body: string) => ({
			name: "issue_comment",
			action: "created",
			payload: {
				issue: { number: 7 },
				sender: { login: "dev" },
				comment: { body, author_association: association },
			},
		});

		expect(route(comment("MEMBER", "/fixloop retry please"))).toEqual({
			kind: "retry",
			issue: 7,
			actor: "dev",
		});
		expect(route(comment("OWNER", "/fixloop stop"))).toMatchObject({
			kind: "stop",
		});
		expect(route(comment("NONE", "/fixloop stop")).kind).toBe("ignore");
		expect(route(comment("MEMBER", "just a normal comment")).kind).toBe(
			"ignore",
		);
	});
});

describe("guard", () => {
	const start = { kind: "start" as const, issue: 7, actor: "reporter" };

	it("allows a normal start", () => {
		expect(
			guard({ command: start, labels: [], activeRunForIssue: false }),
		).toEqual({ allowed: true });
	});

	it("blocks issues labelled fixloop:skip", () => {
		expect(
			guard({
				command: start,
				labels: ["fixloop:skip"],
				activeRunForIssue: false,
			}).allowed,
		).toBe(false);
	});

	it("blocks a second start while a run is active", () => {
		expect(
			guard({ command: start, labels: [], activeRunForIssue: true })
				.allowed,
		).toBe(false);
	});
});

describe("renderStatus", () => {
	it("includes the hidden marker so the comment can be edited in place", () => {
		const body = renderStatus({
			runId: "123",
			headline: "received",
			stages: [{ name: "Intake", state: "done", detail: "bug, backend" }],
		});

		expect(body.startsWith(STATUS_MARKER)).toBe(true);
		expect(body).toContain("✅ **Intake** — bug, backend");
	});
});
