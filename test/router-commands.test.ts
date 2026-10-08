import { describe, expect, it } from "vitest";
import { guard } from "../src/pipeline/guard.js";
import { route } from "../src/router.js";

const comment = (body: string, association = "MEMBER") => ({
	name: "issue_comment",
	action: "created",
	payload: {
		issue: { number: 7, user: { login: "rita" }, labels: [] },
		sender: { login: "dev" },
		comment: { body, author_association: association },
	},
});

describe("route: hint", () => {
	it("takes the text after the command", () => {
		expect(route(comment("/fixloop hint look at the sort order"))).toEqual({
			kind: "hint",
			issue: 7,
			actor: "dev",
			text: "look at the sort order",
		});
	});

	it("keeps following lines and caps the text at 2000 characters", () => {
		expect(route(comment("/fixloop hint one\ntwo"))).toMatchObject({
			text: "one\ntwo",
		});

		const long = route(comment(`/fixloop hint ${"x".repeat(5000)}`));

		expect(long.kind === "hint" && long.text).toHaveLength(2000);
	});

	it("is ignored from an untrusted author", () => {
		expect(route(comment("/fixloop hint try x", "NONE")).kind).toBe(
			"ignore",
		);
		expect(route(comment("/fixloop hint try x", "CONTRIBUTOR")).kind).toBe(
			"ignore",
		);
	});

	it("is ignored without text, or when the command is not first", () => {
		expect(route(comment("/fixloop hint")).kind).toBe("ignore");
		expect(route(comment("/fixloop hint   \n ")).kind).toBe("ignore");
		expect(route(comment("note\n/fixloop hint try x")).kind).toBe("ignore");
		expect(route(comment("/fixloop hinting at it")).kind).toBe("ignore");
	});

	it("is not on a pull request", () => {
		const event = comment("/fixloop hint try x");

		(event.payload.issue as Record<string, unknown>).pull_request = {};
		expect(route(event).kind).toBe("ignore");
	});
});

describe("route: escalate", () => {
	it("is routed from a collaborator", () => {
		expect(route(comment("/fixloop escalate", "COLLABORATOR"))).toEqual({
			kind: "escalate",
			issue: 7,
			actor: "dev",
		});
	});

	it("is ignored from an untrusted author", () => {
		expect(route(comment("/fixloop escalate", "NONE")).kind).toBe("ignore");
	});
});

describe("guard for the new commands", () => {
	it("allows hint, escalate and revise unless the issue opted out", () => {
		const commands = [
			{ kind: "hint" as const, issue: 7, actor: "dev", text: "x" },
			{ kind: "escalate" as const, issue: 7, actor: "dev" },
			{
				kind: "revise" as const,
				prNumber: 3,
				headRef: "fixloop/issue-7",
				headSha: "abc",
				issue: 7,
				text: "x",
			},
		];

		for (const command of commands) {
			expect(
				guard({ command, labels: [], activeRunForIssue: false }),
			).toEqual({ allowed: true });
			expect(
				guard({
					command,
					labels: ["fixloop:skip"],
					activeRunForIssue: false,
				}).allowed,
			).toBe(false);
		}
	});
});

describe("route: review feedback", () => {
	const review = (
		over: {
			state?: string;
			association?: string;
			ref?: string;
			body?: string | null;
			headRepo?: string;
			action?: string;
		} = {},
	) => ({
		name: "pull_request_review",
		action: over.action ?? "submitted",
		payload: {
			review: {
				state: over.state ?? "changes_requested",
				body:
					over.body === undefined
						? "Handle the empty list."
						: over.body,
				author_association: over.association ?? "MEMBER",
			},
			pull_request: {
				number: 31,
				head: {
					ref: over.ref ?? "fixloop/issue-7",
					sha: "abc123",
					repo: { full_name: over.headRepo ?? "o/r" },
				},
				base: { repo: { full_name: "o/r" } },
			},
		},
	});

	it("revises when a collaborator requests changes on a FixLoop PR", () => {
		expect(route(review())).toEqual({
			kind: "revise",
			prNumber: 31,
			headRef: "fixloop/issue-7",
			headSha: "abc123",
			issue: 7,
			text: "Handle the empty list.",
		});
	});

	it("caps the review text, and says so when the review has none", () => {
		const long = route(review({ body: "y".repeat(3000) }));

		expect(long.kind === "revise" && long.text).toHaveLength(2000);

		for (const body of ["", "  \n", null]) {
			expect(route(review({ body }))).toMatchObject({
				kind: "revise",
				text: "The reviewer requested changes without a comment.",
			});
		}
	});

	it("ignores a review from an untrusted author", () => {
		expect(route(review({ association: "NONE" })).kind).toBe("ignore");
		expect(route(review({ association: "CONTRIBUTOR" })).kind).toBe(
			"ignore",
		);
	});

	it("ignores reviews that do not ask for changes", () => {
		expect(route(review({ state: "approved" })).kind).toBe("ignore");
		expect(route(review({ state: "commented" })).kind).toBe("ignore");
		expect(route(review({ action: "edited" })).kind).toBe("ignore");
	});

	it("ignores a review on a PR that is not FixLoop's", () => {
		expect(route(review({ ref: "feature/x" })).kind).toBe("ignore");
		expect(route(review({ ref: "fixloop/other" })).kind).toBe("ignore");
		expect(route(review({ ref: "fixloop/issue-x" })).kind).toBe("ignore");
	});

	it("ignores a PR from a fork whose branch is named like ours", () => {
		expect(route(review({ headRepo: "mallory/r" })).kind).toBe("ignore");
	});
});

describe("route: revert pull requests", () => {
	const closed = (ref: string, title: string, merged = true) => ({
		name: "pull_request",
		action: "closed",
		payload: {
			pull_request: { number: 40, title, merged, head: { ref } },
		},
	});

	it("reports a merged revert", () => {
		expect(
			route(
				closed(
					"revert-31-fixloop/issue-7",
					'Revert "Fix #7: tasks vanish"',
				),
			),
		).toEqual({
			kind: "outcome",
			prNumber: 40,
			merged: true,
			title: 'Revert "Fix #7: tasks vanish"',
		});
	});

	it("reports a revert closed without merging", () => {
		expect(
			route(closed("revert-31-x", 'Revert "Fix #7"', false)),
		).toMatchObject({ kind: "outcome", merged: false });
	});

	it("needs both the branch and the title to look like a revert", () => {
		expect(route(closed("revert-31-x", "Fix #7")).kind).toBe("ignore");
		expect(route(closed("feature/x", 'Revert "Fix #7"')).kind).toBe(
			"ignore",
		);
	});

	it("still routes a FixLoop branch whatever its title", () => {
		expect(route(closed("fixloop/issue-7", "Anything")).kind).toBe(
			"outcome",
		);
	});
});
