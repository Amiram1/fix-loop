import { describe, expect, it } from "vitest";
import { route } from "../src/router.js";

const pullRequest = (
	action: string,
	pr: { ref?: string; merged?: boolean; title?: string } = {},
) => ({
	name: "pull_request",
	action,
	payload: {
		action,
		pull_request: {
			number: 31,
			title: pr.title ?? "Fix #7: tasks vanish",
			merged: pr.merged ?? false,
			head: { ref: pr.ref ?? "fixloop/issue-7" },
		},
	},
});

describe("route: pull request outcome", () => {
	it("reports a merged FixLoop PR", () => {
		expect(route(pullRequest("closed", { merged: true }))).toEqual({
			kind: "outcome",
			prNumber: 31,
			merged: true,
			title: "Fix #7: tasks vanish",
		});
	});

	it("reports a FixLoop PR closed without merging", () => {
		expect(route(pullRequest("closed"))).toMatchObject({
			kind: "outcome",
			merged: false,
		});
	});

	it("ignores a PR from any other branch", () => {
		expect(
			route(pullRequest("closed", { ref: "feature/x", merged: true }))
				.kind,
		).toBe("ignore");
		expect(
			route(pullRequest("closed", { ref: "notfixloop/issue-7" })).kind,
		).toBe("ignore");
	});

	it("ignores a PR that is still open", () => {
		expect(route(pullRequest("opened")).kind).toBe("ignore");
		expect(route(pullRequest("synchronize")).kind).toBe("ignore");
	});

	it("ignores a closed event with no pull request in the payload", () => {
		expect(
			route({ name: "pull_request", action: "closed", payload: {} }).kind,
		).toBe("ignore");
	});
});
