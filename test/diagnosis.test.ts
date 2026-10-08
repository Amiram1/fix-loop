import { describe, expect, it } from "vitest";
import {
	DIAGNOSIS_MARKER,
	postDiagnosis,
	renderDiagnosis,
} from "../src/notify/diagnosis.js";
import type {
	FixResult,
	GateResult,
	Reproduction,
} from "../src/pipeline/artifacts.js";
import { STATUS_MARKER } from "../src/ui/statusComment.js";
import { comment, fakeOctokit, REPO } from "./fakeOctokit.js";

const reproduction: Reproduction = {
	status: "reproduced",
	area: "backend",
	testPath: "pkg/models/task_test.go",
	testName: "TestTaskDueDateFilter",
	evidence: [
		"=== RUN   TestTaskDueDateFilter",
		"    task_test.go:42: expected 3 tasks before 2026-01-01, got 2",
		"    task_test.go:43: task 3 (due 2025-12-31) was dropped",
		"--- FAIL: TestTaskDueDateFilter (0.01s)",
		"FAIL",
		"exit status 1",
	].join("\n"),
	attempts: 2,
	costUsd: 0.1,
};

const notFixed: FixResult = {
	status: "not_fixed",
	diff: "",
	filesChanged: [],
	models: ["claude-sonnet-5-5", "claude-opus-5"],
	attempts: 4,
	costUsd: 1.234,
	reason: "no accepted fix after 4 attempt(s): the full suite still fails",
};

const gate: GateResult = {
	delivery: "diagnosis_only",
	confidence: 0.45,
	risky: true,
	reasons: ["touches risk path auth/**", "confidence 0.45 is below 0.5"],
};

describe("renderDiagnosis", () => {
	it("names the failing test, the evidence, what was tried and the gate reasons", () => {
		const body = renderDiagnosis({ reproduction, fix: notFixed, gate });

		expect(body.startsWith(DIAGNOSIS_MARKER)).toBe(true);
		expect(body).toContain("`TestTaskDueDateFilter`");
		expect(body).toContain("`pkg/models/task_test.go`");
		expect(body).toContain("expected 3 tasks before 2026-01-01, got 2");
		expect(body).toContain(
			"4 fix attempt(s) with claude-sonnet-5-5, claude-opus-5",
		);
		expect(body).toContain("the full suite still fails");
		expect(body).toContain("touches risk path auth/**");
		expect(body).toContain("a person should make or review it");
		expect(body).toContain("/fixloop retry");
		expect(body).toContain("<details><summary>Raw evidence</summary>");
	});

	it("leaves test-runner chatter out of the hypothesis but keeps it in the raw evidence", () => {
		const body = renderDiagnosis({ reproduction, fix: notFixed, gate });

		const [hypothesis, raw] = body.split("<details>");

		expect(hypothesis).not.toContain("=== RUN");
		expect(raw).toContain("=== RUN");
	});

	it("says when a fix passed the tests but the gate withheld it", () => {
		const body = renderDiagnosis({
			reproduction,
			fix: {
				...notFixed,
				status: "fixed",
				filesChanged: ["a.go", "b.go"],
				reason: undefined,
			},
			gate: { ...gate, risky: false },
		});

		expect(body).toContain("A change touching 2 file(s) passed");
		expect(body).toContain("the gate did not trust it enough");
	});

	it("renders without a fix, a gate or evidence", () => {
		const body = renderDiagnosis({
			reproduction: {
				...reproduction,
				evidence: undefined,
				testName: undefined,
			},
		});

		expect(body).toContain("No fix was attempted.");
		expect(body).toContain("No failing test was kept");
		expect(body).not.toContain("<details>");
	});

	it("stays near 40 lines even with long evidence and many reasons", () => {
		const body = renderDiagnosis({
			reproduction: {
				...reproduction,
				evidence: Array.from(
					{ length: 200 },
					(_, i) => `line ${i} ${"x".repeat(500)}`,
				).join("\n"),
			},
			fix: { ...notFixed, reason: "r\n".repeat(500) },
			gate: {
				...gate,
				reasons: Array.from({ length: 20 }, (_, i) => `reason ${i}`),
			},
		});

		expect(body.split("\n").length).toBeLessThanOrEqual(40);
		expect(body).toContain("line 0 "); // the first lines are the hypothesis
		expect(body).not.toContain("line 50 ");
		expect(body).toContain("line 199 ");
	});

	it("cannot be broken out of by backticks in the evidence", () => {
		const body = renderDiagnosis({
			reproduction: { ...reproduction, evidence: "boom ``` @everyone" },
		});

		expect(body).not.toMatch(/boom ```/);
	});

	it("renders a sample", () => {
		expect(
			renderDiagnosis({ reproduction, fix: notFixed, gate }),
		).toMatchInlineSnapshot(`
			"<!-- fixloop:diagnosis -->
			### FixLoop · diagnosis, no pull request

			FixLoop reproduced this bug but did not open a pull request. Here is what it found.

			**Root-cause hypothesis**
			The failing test \`TestTaskDueDateFilter\` in \`pkg/models/task_test.go\` fails with:
			\`\`\`text
			    task_test.go:42: expected 3 tasks before 2026-01-01, got 2
			    task_test.go:43: task 3 (due 2025-12-31) was dropped
			--- FAIL: TestTaskDueDateFilter (0.01s)
			\`\`\`

			**What FixLoop tried**
			- 4 fix attempt(s) with claude-sonnet-5-5, claude-opus-5 (cost $1.23).
			- No accepted fix. Last failure: \`no accepted fix after 4 attempt(s): the full suite still fails\`

			**Why no pull request**
			- touches risk path auth/**
			- confidence 0.45 is below 0.5

			**Next step**
			The change touches a risky area (or the issue is S1), so a person should make or review it. Start from the failing test above. After adding detail to the issue, a collaborator can comment \`/fixloop retry\`.

			<details><summary>Raw evidence</summary>

			\`\`\`text
			=== RUN   TestTaskDueDateFilter
			    task_test.go:42: expected 3 tasks before 2026-01-01, got 2
			    task_test.go:43: task 3 (due 2025-12-31) was dropped
			--- FAIL: TestTaskDueDateFilter (0.01s)
			FAIL
			exit status 1
			\`\`\`
			</details>"
		`);
	});
});

describe("postDiagnosis", () => {
	it("adds one comment, and edits it on a repeat", async () => {
		const { octokit, state } = fakeOctokit();

		const first = await postDiagnosis(octokit, REPO, {
			reproduction,
			fix: notFixed,
			gate,
		});

		expect(first.status).toBe("diagnosis_posted");
		expect(state.comments).toHaveLength(1);

		await postDiagnosis(octokit, REPO, {
			reproduction,
			fix: { ...notFixed, attempts: 9 },
			gate,
		});

		expect(state.comments).toHaveLength(1);
		expect(state.comments[0]?.body).toContain("9 fix attempt(s)");
	});

	it("leaves the status comment alone", async () => {
		const { octokit, state } = fakeOctokit({
			comments: [
				comment(
					1,
					"github-actions[bot]",
					`${STATUS_MARKER}\nstopped`,
					1,
				),
			],
		});

		await postDiagnosis(octokit, REPO, { reproduction, gate });

		expect(state.comments).toHaveLength(2);
		expect(state.comments[0]?.body).toBe(`${STATUS_MARKER}\nstopped`);
	});
});

describe("hypothesis lines", () => {
	it("leads with the lines that say what failed, not the setup lines before them", () => {
		const text = renderDiagnosis({
			reproduction: {
				status: "reproduced",
				area: "backend",
				testPath: "pkg/x_test.go",
				testName: "TestReproX",
				evidence: [
					"=== RUN TestReproX",
					"setting up the fixture",
					"--- FAIL: TestReproX (0.00s)",
					"    x_test.go:12: expected 3 tasks, got 2",
				].join("\n"),
				attempts: 1,
				costUsd: 0,
			},
			gate: undefined,
		});

		// The raw evidence block below the hypothesis may still show setup lines; the hypothesis must not.
		const hypothesis =
			text
				.split("**Root-cause hypothesis**")[1]
				?.split("**What FixLoop tried**")[0] ?? "";

		expect(hypothesis).toContain("--- FAIL: TestReproX");
		expect(hypothesis).toContain("expected 3 tasks, got 2");
		expect(hypothesis).not.toContain("setting up the fixture");
	});
});
