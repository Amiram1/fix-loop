import { describe, expect, it } from "vitest";
import {
	MAX_REPLIES,
	MAX_REPLY_CHARS,
	repliesSince,
	resumeFromReplies,
} from "../src/adapters/comments.js";
import { NEEDS_INFO_MARKER } from "../src/notify/needsInfo.js";
import { NEEDS_INFO_LABEL } from "../src/router.js";
import { STATUS_MARKER } from "../src/ui/statusComment.js";
import { comment, fakeOctokit, REPO } from "./fakeOctokit.js";

const BOT = "github-actions[bot]";

describe("repliesSince", () => {
	it("returns only the reporter's comments after the last FixLoop comment", async () => {
		const { octokit } = fakeOctokit({
			reporter: "rita",
			comments: [
				comment(1, "rita", "before FixLoop ever ran", 1),
				// Created first, edited with the question at minute 10: the edit time is the cut-off.
				comment(
					2,
					BOT,
					`${STATUS_MARKER}\n${NEEDS_INFO_MARKER}\nquestion`,
					2,
					10,
				),
				comment(3, "rita", "reply one", 11),
				comment(4, "someone-else", "me too", 12),
				comment(5, "rita", "reply two", 13),
			],
		});

		expect(await repliesSince(octokit, REPO)).toEqual([
			"reply one",
			"reply two",
		]);
	});

	it("takes the latest of several FixLoop comments", async () => {
		const { octokit } = fakeOctokit({
			reporter: "rita",
			comments: [
				comment(1, BOT, `${STATUS_MARKER}\nrunning`, 1, 5),
				comment(2, "rita", "old answer", 3),
				comment(3, BOT, `${NEEDS_INFO_MARKER}\nsecond question`, 6),
				comment(4, "rita", "new answer", 7),
			],
		});

		expect(await repliesSince(octokit, REPO)).toEqual(["new answer"]);
	});

	it("does not let the reporter move the cut-off by pasting a marker", async () => {
		const { octokit } = fakeOctokit({
			reporter: "rita",
			comments: [
				comment(1, BOT, `${STATUS_MARKER}\nquestion`, 1),
				comment(2, "rita", `quoting ${NEEDS_INFO_MARKER}`, 5),
				comment(3, "rita", "real answer", 6),
			],
		});

		expect(await repliesSince(octokit, REPO)).toHaveLength(2);
	});

	it("caps the count (keeping the latest) and the length of each reply", async () => {
		const many = Array.from({ length: MAX_REPLIES + 3 }, (_, i) =>
			comment(10 + i, "rita", `reply ${i}`, 20 + i),
		);

		const { octokit } = fakeOctokit({
			reporter: "rita",
			comments: [
				comment(1, BOT, STATUS_MARKER, 1),
				...many,
				comment(99, "rita", "x".repeat(MAX_REPLY_CHARS + 500), 50),
			],
		});

		const replies = await repliesSince(octokit, REPO);

		expect(replies).toHaveLength(MAX_REPLIES);
		expect(replies[0]).toBe("reply 4");
		expect(replies.at(-1)).toHaveLength(MAX_REPLY_CHARS);
	});

	it("skips empty comments, and returns nothing when the issue has no author", async () => {
		const { octokit } = fakeOctokit({
			reporter: "rita",
			comments: [comment(1, "rita", "  \n ", 1)],
		});

		expect(await repliesSince(octokit, REPO)).toEqual([]);

		const ghost = fakeOctokit({
			comments: [comment(1, "rita", "hello", 1)],
		});

		expect(await repliesSince(ghost.octokit, REPO)).toEqual([]);
	});
});

describe("resumeFromReplies", () => {
	const issue = () => ({
		number: 7,
		title: "t",
		body: "b",
		labels: [NEEDS_INFO_LABEL, "bug"],
	});

	it("sets the replies and clears the needs-info label, here and on GitHub", async () => {
		const { octokit, state } = fakeOctokit({
			reporter: "rita",
			issueLabels: [NEEDS_INFO_LABEL, "bug"],
			comments: [
				comment(1, BOT, `${STATUS_MARKER}\n${NEEDS_INFO_MARKER}`, 1),
				comment(2, "rita", "it happens on the board view", 5),
			],
		});

		const info = issue();

		await resumeFromReplies(octokit, REPO, info);

		expect(info.replies).toEqual(["it happens on the board view"]);
		expect(info.labels).toEqual(["bug"]);
		expect([...state.issueLabels]).toEqual(["bug"]);
	});

	it("is fine when the label was already removed", async () => {
		const { octokit } = fakeOctokit({ reporter: "rita" });

		const info = issue();

		await expect(
			resumeFromReplies(octokit, REPO, info),
		).resolves.toBeUndefined();
		expect(info.replies).toEqual([]);
	});
});
