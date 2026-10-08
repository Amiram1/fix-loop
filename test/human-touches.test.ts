import { describe, expect, it } from "vitest";
import {
	countHumanComments,
	countHumanTouches,
} from "../src/adapters/github.js";
import { comment, fakeOctokit, REPO } from "./fakeOctokit.js";

const SINCE = "2026-01-01T10:10:00Z";

describe("countHumanComments", () => {
	it("counts people, not bots", () => {
		expect(
			countHumanComments(
				[
					comment(1, "reporter", "still broken", 15),
					comment(2, "maintainer", "/fixloop retry", 20),
					comment(3, "github-actions[bot]", "status", 12),
					comment(4, "github-actions", "status", 12),
					comment(5, "dependabot[bot]", "hi", 12),
					comment(6, "GitHub-Actions", "status", 12),
				],
				SINCE,
			),
		).toBe(2);
	});

	it("counts comments created at or after the start, not before", () => {
		expect(
			countHumanComments(
				[
					comment(1, "reporter", "the report", 9),
					comment(2, "reporter", "exactly at the start", 10),
					comment(3, "reporter", "after", 11),
				],
				SINCE,
			),
		).toBe(2);
	});

	it("goes by creation time, not by edits", () => {
		// Created before the run, edited during it: not a touch.
		expect(
			countHumanComments(
				[comment(1, "reporter", "edited", 5, 30)],
				SINCE,
			),
		).toBe(0);
	});

	it("counts a comment whose author is gone, and none for no comments", () => {
		expect(
			countHumanComments(
				[{ ...comment(1, "x", "orphan", 15), user: null }],
				SINCE,
			),
		).toBe(1);
		expect(countHumanComments([], SINCE)).toBe(0);
	});
});

describe("countHumanTouches", () => {
	it("reads the issue's comments through the API and filters them", async () => {
		const { octokit } = fakeOctokit({
			comments: [
				comment(1, "reporter", "report", 1),
				comment(2, "github-actions[bot]", "status", 11),
				comment(3, "reporter", "reply", 12),
			],
		});

		expect(await countHumanTouches(octokit, REPO, SINCE)).toBe(1);
	});
});
