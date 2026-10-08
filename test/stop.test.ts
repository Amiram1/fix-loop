import type { Octokit } from "@octokit/rest";
import { describe, expect, it, vi } from "vitest";
import { findRunId, stopRun } from "../src/adapters/comments.js";
import { renderStatus, STATUS_MARKER } from "../src/ui/statusComment.js";
import { comment, fakeOctokit, REPO } from "./fakeOctokit.js";

const status = (runId: string) =>
	renderStatus({ runId, headline: "running", stages: [] });

describe("findRunId", () => {
	it("reads the id from the status comment", () => {
		expect(findRunId(["hello", status("9876543210")])).toBe("9876543210");
	});

	it("takes the latest status comment when there are several", () => {
		expect(findRunId([status("1"), status("2")])).toBe("2");
	});

	it("ignores comments without the marker", () => {
		expect(findRunId(["run `123`", "nothing"])).toBeUndefined();
	});

	it("is undefined when the status comment has no numeric run id", () => {
		expect(findRunId([status("local")])).toBeUndefined();
		expect(findRunId([`${STATUS_MARKER}\nno run line`])).toBeUndefined();
		expect(findRunId([])).toBeUndefined();
	});
});

describe("stopRun", () => {
	const setup = (
		comments = [comment(1, "github-actions[bot]", status("555"), 1)],
		cancel = vi.fn(async () => ({})),
	) => {
		const { octokit, state } = fakeOctokit({ comments });

		Object.assign(octokit, { actions: { cancelWorkflowRun: cancel } });

		return { octokit: octokit as Octokit, state, cancel };
	};

	it("cancels the run on the status comment and says so on the issue", async () => {
		const { octokit, state, cancel } = setup();

		await stopRun(octokit, REPO, "dev", "999");

		expect(cancel).toHaveBeenCalledWith({
			owner: "o",
			repo: "r",
			run_id: 555,
		});
		expect(state.comments.at(-1)?.body).toContain("Cancelling run `555`");
	});

	it("says so when no run is recorded, and cancels nothing", async () => {
		const { octokit, state, cancel } = setup([]);

		await stopRun(octokit, REPO, "dev");

		expect(cancel).not.toHaveBeenCalled();
		expect(state.comments.at(-1)?.body).toContain("no run is recorded");
	});

	it("ignores a status comment pasted by a person", async () => {
		const { octokit, cancel } = setup([
			comment(1, "mallory", status("777"), 1),
		]);

		await stopRun(octokit, REPO, "dev");

		expect(cancel).not.toHaveBeenCalled();
	});

	it("never cancels the run it is itself", async () => {
		const { octokit, cancel } = setup();

		await stopRun(octokit, REPO, "dev", "555");

		expect(cancel).not.toHaveBeenCalled();
	});

	it("reports a run that could not be cancelled", async () => {
		const { octokit, state } = setup(
			undefined,
			vi.fn(async () => {
				throw new Error(
					"Cannot cancel a workflow run that is completed.",
				);
			}),
		);

		await stopRun(octokit, REPO, "dev");

		expect(state.comments.at(-1)?.body).toContain("could not be cancelled");
		expect(state.comments.at(-1)?.body).toContain("completed");
	});
});
