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

describe("route: reporter replies", () => {
	const reply = (
		over: {
			sender?: string;
			author?: string;
			labels?: unknown[];
			association?: string;
			body?: string;
			pullRequest?: boolean;
		} = {},
	) => ({
		name: "issue_comment",
		action: "created",
		payload: {
			issue: {
				number: 7,
				user: { login: over.author ?? "rita" },
				labels: over.labels ?? [
					{ name: "bug" },
					{ name: "needs-info" },
				],
				...(over.pullRequest ? { pull_request: {} } : {}),
			},
			sender: { login: over.sender ?? "rita" },
			comment: {
				body: over.body ?? "it is the board view",
				author_association: over.association ?? "NONE",
			},
		},
	});

	it("resumes when the issue author comments on a needs-info issue", () => {
		expect(route(reply())).toEqual({
			kind: "reply",
			issue: 7,
			actor: "rita",
		});
	});

	it("reads labels given as plain strings too", () => {
		expect(route(reply({ labels: ["needs-info"] })).kind).toBe("reply");
	});

	it("ignores the author when the issue is not waiting for information", () => {
		expect(route(reply({ labels: [{ name: "bug" }] })).kind).toBe("ignore");
		expect(route(reply({ labels: [] })).kind).toBe("ignore");
	});

	it("ignores anyone but the issue author, even a collaborator", () => {
		expect(
			route(reply({ sender: "dev", association: "MEMBER" })).kind,
		).toBe("ignore");
	});

	it("ignores comments on pull requests", () => {
		expect(route(reply({ pullRequest: true })).kind).toBe("ignore");
	});

	it("ignores an author-less payload instead of matching undefined to undefined", () => {
		const event = reply();

		event.payload.issue.user = undefined as never;
		event.payload.sender = undefined as never;

		expect(route(event).kind).toBe("ignore");
	});

	it("keeps retry and stop as they were, whoever wrote them", () => {
		expect(
			route(reply({ body: "/fixloop retry", association: "OWNER" })),
		).toEqual({ kind: "retry", issue: 7, actor: "rita" });
		expect(
			route(reply({ body: "/fixloop stop", association: "MEMBER" })).kind,
		).toBe("stop");
		// An untrusted author's command is still refused, not read as a reply.
		expect(
			route(reply({ body: "/fixloop retry", association: "NONE" })).kind,
		).toBe("ignore");
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
