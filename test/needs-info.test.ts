import { describe, expect, it } from "vitest";
import {
	NEEDS_INFO_LABEL,
	NEEDS_INFO_MARKER,
	postNeedsInfo,
	renderNeedsInfo,
} from "../src/notify/needsInfo.js";
import { STATUS_MARKER } from "../src/ui/statusComment.js";
import { comment, fakeOctokit, REPO } from "./fakeOctokit.js";

describe("renderNeedsInfo", () => {
	it("asks for steps, expected and actual results, and the environment", () => {
		const body = renderNeedsInfo({
			reason: "the agent ended without finishing a RED test",
			title: "Tasks vanish",
		});

		expect(body).toMatchInlineSnapshot(`
			"<!-- fixloop:status -->
			<!-- fixloop:needs-info -->
			### FixLoop · needs more information

			I could not reproduce \`Tasks vanish\` from the report, so I have not tried a fix.
			What stopped me: \`the agent ended without finishing a RED test\`

			Could you reply on this issue with:
			1. The steps to reproduce, starting from a fresh state, as exact as you can.
			2. What you expected to happen and what happened instead (error text or a screenshot).
			3. Your environment: version or commit, browser or OS, and any settings or data that matter.

			When you reply, FixLoop picks the run up again and removes the \`needs-info\` label."
		`);
	});

	it("carries both markers, so it is edited in place and found as a question", () => {
		const body = renderNeedsInfo({ reason: "x", title: "t" });

		expect(body).toContain(STATUS_MARKER);
		expect(body).toContain(NEEDS_INFO_MARKER);
	});

	it("asks about the page when the test could not reach it", () => {
		const body = renderNeedsInfo({
			reason: "not reproduced: the test timed out waiting for a page it never found",
			title: "t",
		});

		expect(body).toContain("Which page or screen were you on");
		expect(body).not.toContain("not reproduced:");
	});

	it("asks for exact data when the test passed", () => {
		const body = renderNeedsInfo({
			reason: "the test passed, so it does not show the bug",
			title: "t",
		});

		expect(body).toContain("Which exact values or data triggered it?");
		expect(body).not.toContain("Which page or screen");
	});

	it("keeps untrusted text in code spans so it cannot ping or format", () => {
		const body = renderNeedsInfo({
			reason: "saw @everyone\n`injected` text",
			title: "@org/team **bold**",
		});

		expect(body).toContain("`@org/team **bold**`");
		expect(body).toContain("`saw @everyone 'injected' text`");
	});
});

describe("postNeedsInfo", () => {
	const input = { reason: "no red test", title: "t" };

	it("writes the question as the status comment, edited in place on a repeat", async () => {
		const { octokit, state } = fakeOctokit({
			comments: [
				comment(
					1,
					"github-actions[bot]",
					`${STATUS_MARKER}\nrunning`,
					1,
				),
			],
		});

		const result = await postNeedsInfo(octokit, REPO, input);

		expect(result.status).toBe("needs_info_posted");
		expect(state.comments).toHaveLength(1);
		expect(state.comments[0]?.body).toContain(NEEDS_INFO_MARKER);

		await postNeedsInfo(octokit, REPO, input);

		expect(state.comments).toHaveLength(1);
	});

	it("creates the status comment when there is none", async () => {
		const { octokit, state } = fakeOctokit();

		await postNeedsInfo(octokit, REPO, input);

		expect(state.comments).toHaveLength(1);
		expect(state.comments[0]?.body).toContain(NEEDS_INFO_MARKER);
	});

	it("adds the label and creates it when the repository does not have it", async () => {
		const { octokit, state } = fakeOctokit();

		await postNeedsInfo(octokit, REPO, input);

		expect(state.created).toEqual([NEEDS_INFO_LABEL]);
		expect([...state.issueLabels]).toEqual([NEEDS_INFO_LABEL]);
	});

	it("does not create a label that exists", async () => {
		const { octokit, state } = fakeOctokit({
			repoLabels: [NEEDS_INFO_LABEL],
		});

		await postNeedsInfo(octokit, REPO, input);

		expect(state.created).toEqual([]);
		expect([...state.issueLabels]).toEqual([NEEDS_INFO_LABEL]);
	});

	it("does not hide a failure other than a missing label", async () => {
		const { octokit } = fakeOctokit();

		octokit.issues.getLabel = (async () => {
			throw Object.assign(new Error("rate limited"), { status: 403 });
		}) as unknown as typeof octokit.issues.getLabel;

		await expect(postNeedsInfo(octokit, REPO, input)).rejects.toThrow(
			"rate limited",
		);
	});
});
