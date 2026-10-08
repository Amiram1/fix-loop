import { execFile } from "node:child_process";
import { chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureLabels, labelsFor } from "../src/adapters/labels.js";
import { parseConfig } from "../src/config/load.js";
import { branchName, commitFixBranch } from "../src/deliver/branch.js";
import { deliverFix } from "../src/deliver/deliver.js";
import type { FixResult, GateResult } from "../src/pipeline/artifacts.js";
import type { RunContext } from "../src/pipeline/run.js";
import { fakeOctokit } from "./helpers/fake-octokit.js";
import { diffOf, type FixRepo, makeRepo, write } from "./helpers/fix-repo.js";

const exec = promisify(execFile);

const config = parseConfig(
	"app:\n  up: x\n  base_url: http://localhost:3456\ntests:\n  full: go test ./...\n",
);

const ref = { owner: "o", repo: "r", issue: 5 };

const gateOf = (delivery: GateResult["delivery"]): GateResult => ({
	delivery,
	confidence: delivery === "ready_pr" ? 1 : 0.7,
	risky: false,
	reasons: ["The bug was reproduced by a failing test."],
});

let repo: FixRepo;

let fix: FixResult;

beforeEach(async () => {
	repo = await makeRepo({
		".github/CODEOWNERS": "* @owner\n",
		"pkg/a.go": "package a\n\nfunc A() int { return 1 }\n",
		"pkg/gone.go": "package a\n",
	});

	const { diff, files } = await diffOf(repo, async (dir) => {
		await write(
			dir,
			"pkg/a.go",
			"package a\n\nfunc A() int { return 2 }\n",
		);
		await write(dir, "pkg/new.go", "package a\n\nfunc B() {}\n");
		await write(dir, "scripts/run.sh", "#!/bin/sh\necho hi\n");
		await chmod(join(dir, "scripts/run.sh"), 0o755);
		await rm(join(dir, "pkg/gone.go"));
	});

	fix = {
		status: "fixed",
		diff,
		filesChanged: files,
		models: ["claude-sonnet-5-5"],
		attempts: 2,
		costUsd: 0.3,
	};
});

afterEach(() => repo.cleanup());

function ctxWith(artifacts: Partial<RunContext["artifacts"]> = {}): RunContext {
	return {
		runId: "t",
		config,
		issue: {
			number: 5,
			title: "Wrong\nvalue   on page",
			body: "b",
			labels: [],
		},
		dryRun: false,
		artifacts: {
			intake: {
				area: "backend",
				severity: "S3",
				summary: "s",
				injectionSuspected: false,
			},
			reproduction: {
				status: "reproduced",
				area: "backend",
				testPath: "pkg/a_test.go",
				testName: "TestA",
				evidence: "--- FAIL: TestA\n    a_test.go:9: want 2, got 1",
				attempts: 1,
				costUsd: 0.1,
			},
			fix,
			...artifacts,
		},
	};
}

const deliver = (
	delivery: GateResult["delivery"],
	fake: ReturnType<typeof fakeOctokit> | undefined,
	extra: Partial<Parameters<typeof deliverFix>[0]> = {},
) =>
	deliverFix({
		root: repo.root,
		headSha: repo.sha,
		ctx: ctxWith(),
		gate: gateOf(delivery),
		octokit: fake?.octokit,
		dryRun: false,
		ref,
		...extra,
	});

describe("deliverFix", () => {
	it("diagnosis_only opens nothing and touches nothing", async () => {
		const fake = fakeOctokit();

		expect(await deliver("diagnosis_only", fake)).toEqual({
			status: "skipped",
			detail: "no PR: the diagnosis is posted instead",
		});
		expect(fake.calls).toEqual([]);
	});

	it("ready_pr opens a ready PR with labels, a CODEOWNERS reviewer and the fix commit", async () => {
		const fake = fakeOctokit({ issueAuthor: "reporter" });

		const result = await deliver("ready_pr", fake);

		expect(result).toMatchObject({
			status: "pr_opened",
			branch: "fixloop/issue-5",
			url: "https://github.test/o/r/pull/100",
		});

		const [create] = fake.called("pulls.create");

		expect(fake.called("pulls.create")).toHaveLength(1);
		expect(create).toMatchObject({
			owner: "o",
			repo: "r",
			head: "fixloop/issue-5",
			base: "main",
			draft: false,
			title: "Fix #5: Wrong value on page",
		});
		expect(String(create?.body)).toContain("Fixes #5");
		expect(fake.called("issues.addLabels")[0]).toMatchObject({
			issue_number: 100,
			labels: ["fixloop", "fixloop:ready", "sev:S3", "area:backend"],
		});
		expect(fake.called("pulls.requestReviewers")[0]).toMatchObject({
			pull_number: 100,
			reviewers: ["owner"],
		});
		expect(result.detail).toContain("@owner (CODEOWNERS)");
	});

	it("draft_pr opens a draft with the draft label", async () => {
		const fake = fakeOctokit();

		await deliver("draft_pr", fake);

		expect(fake.called("pulls.create")[0]).toMatchObject({ draft: true });
		expect(fake.called("issues.addLabels")[0]?.labels).toContain(
			"fixloop:draft",
		);
		expect(fake.called("issues.addLabels")[0]?.labels).not.toContain(
			"fixloop:ready",
		);
	});

	it("updates the open PR for the branch and never creates a second one", async () => {
		const fake = fakeOctokit({
			branches: ["fixloop/issue-5"],
			openPulls: [
				{
					number: 42,
					html_url: "https://github.test/o/r/pull/42",
					draft: false,
					head: "fixloop/issue-5",
				},
			],
		});

		const result = await deliver("ready_pr", fake);

		expect(result).toMatchObject({
			status: "pr_updated",
			url: "https://github.test/o/r/pull/42",
		});
		expect(fake.called("pulls.create")).toHaveLength(0);
		expect(fake.called("pulls.update")).toHaveLength(1);
		expect(fake.called("pulls.update")[0]).toMatchObject({
			pull_number: 42,
		});
		// The existing branch is moved, not recreated.
		expect(fake.called("git.createRef")).toHaveLength(0);
		expect(fake.called("git.updateRef")[0]).toMatchObject({
			ref: "heads/fixloop/issue-5",
			sha: "commit-new",
			force: true,
		});
	});

	it("a second run for the same issue updates the PR the first run opened", async () => {
		const fake = fakeOctokit();

		const first = await deliver("draft_pr", fake);

		const second = await deliver("draft_pr", fake);

		expect(first.status).toBe("pr_opened");
		expect(second).toMatchObject({ status: "pr_updated", url: first.url });
		expect(fake.called("pulls.create")).toHaveLength(1);
	});

	it("says so when an existing draft PR can no longer be switched to ready", async () => {
		const fake = fakeOctokit({
			openPulls: [
				{
					number: 42,
					html_url: "https://github.test/o/r/pull/42",
					draft: true,
					head: "fixloop/issue-5",
				},
			],
		});

		const result = await deliver("ready_pr", fake);

		expect(result.detail).toContain("stays a draft");
	});

	it("a failed reviewer request is not fatal and is reported", async () => {
		const fake = fakeOctokit({
			requestReviewersError: "Review cannot be requested",
		});

		const result = await deliver("ready_pr", fake);

		expect(result.status).toBe("pr_opened");
		expect(result.detail).toContain(
			"Could not request a review from @owner",
		);
		expect(result.detail).toContain("Review cannot be requested");
	});

	it("never picks the issue author as the reviewer, and falls back to git", async () => {
		const fake = fakeOctokit({
			issueAuthor: "owner",
			users: { "alice@x.test": "alice" },
		});

		const result = await deliver("ready_pr", fake);

		expect(fake.called("pulls.requestReviewers")[0]).toMatchObject({
			reviewers: ["alice"],
		});
		expect(result.detail).toContain(
			"@alice (most frequent author in git history)",
		);
	});

	it("opens the PR without a reviewer when none is found", async () => {
		await rm(join(repo.root, ".github"), { recursive: true });

		const fake = fakeOctokit();

		const result = await deliver("ready_pr", fake);

		expect(result.status).toBe("pr_opened");
		expect(fake.called("pulls.requestReviewers")).toHaveLength(0);
		expect(result.detail).toContain("Reviewer: none (");
	});

	it("creates only the labels the repo lacks", async () => {
		const fake = fakeOctokit({ labels: ["fixloop", "Sev:S3"] });

		await deliver("ready_pr", fake);

		expect(fake.called("issues.createLabel").map((a) => a.name)).toEqual([
			"fixloop:ready",
			"area:backend",
		]);
	});

	it("a dry run with an octokit reads but performs no write", async () => {
		const fake = fakeOctokit({ issueAuthor: "reporter" });

		const result = await deliver("ready_pr", fake, { dryRun: true });

		expect(fake.writes()).toEqual([]);
		expect(result).toMatchObject({
			status: "dry_run",
			branch: "fixloop/issue-5",
		});
		expect(result.url).toBeUndefined();
		expect(result.detail).toContain(
			"Would open a ready PR from fixloop/issue-5.",
		);
		expect(result.detail).toContain("title: Fix #5: Wrong value on page");
		expect(result.detail).toContain(
			"labels: fixloop, fixloop:ready, sev:S3, area:backend",
		);
		expect(result.detail).toContain("reviewer: @owner (CODEOWNERS)");
		expect(result.detail).toContain("pkg/a.go (modified)");
		expect(result.detail).toContain("pkg/new.go (added)");
		expect(result.detail).toContain("pkg/gone.go (deleted)");
		expect(result.detail).toContain("Fixes #5");
	});

	it("without an octokit it is a dry run too and does not need a ref", async () => {
		const result = await deliver("draft_pr", undefined, { ref: undefined });

		expect(result.status).toBe("dry_run");
		expect(result.detail).toContain("Would open a draft PR");
		expect(result.detail).toContain("fixloop:draft");
	});

	it("refuses to write without knowing the repo", async () => {
		const fake = fakeOctokit();

		await expect(
			deliver("ready_pr", fake, { ref: undefined }),
		).rejects.toThrow(/ref/);
		expect(fake.writes()).toEqual([]);
	});

	it("opens no PR when the fix did not pass, whatever the gate said", async () => {
		const fake = fakeOctokit();

		const result = await deliverFix({
			root: repo.root,
			headSha: repo.sha,
			ctx: ctxWith({ fix: { ...fix, status: "not_fixed" } }),
			gate: gateOf("draft_pr"),
			octokit: fake.octokit,
			dryRun: false,
			ref,
		});

		expect(result).toMatchObject({ status: "skipped" });
		expect(fake.calls).toEqual([]);
	});
});

describe("commitFixBranch", () => {
	it("a local apply lists the files and needs no octokit", async () => {
		const result = await commitFixBranch({
			root: repo.root,
			headSha: repo.sha,
			diff: fix.diff,
			branch: branchName(5),
			message: "m",
		});

		expect(result).toEqual({
			branch: "fixloop/issue-5",
			files: [
				{ path: "pkg/a.go", status: "modified" },
				{ path: "pkg/gone.go", status: "deleted" },
				{ path: "pkg/new.go", status: "added" },
				{ path: "scripts/run.sh", status: "added" },
			],
		});
	});

	it("builds blobs, a tree on the base tree, a commit on headSha and a new ref", async () => {
		const fake = fakeOctokit();

		const { stdout } = await exec("git", ["rev-parse", "HEAD^{tree}"], {
			cwd: repo.root,
		});

		const result = await commitFixBranch({
			root: repo.root,
			headSha: repo.sha,
			diff: fix.diff,
			branch: "fixloop/issue-5",
			message: "the message",
			write: { octokit: fake.octokit, repo: { owner: "o", repo: "r" } },
		});

		expect(result.commitSha).toBe("commit-new");

		// Only the files that exist after the fix get a blob, with their real content.
		expect(
			fake
				.called("git.createBlob")
				.map((a) =>
					Buffer.from(String(a.content), "base64").toString(),
				),
		).toEqual([
			"package a\n\nfunc A() int { return 2 }\n",
			"package a\n\nfunc B() {}\n",
			"#!/bin/sh\necho hi\n",
		]);

		const [tree] = fake.called("git.createTree");

		expect(tree?.base_tree).toBe(stdout.trim());
		expect(tree?.tree).toEqual([
			{ path: "pkg/a.go", mode: "100644", type: "blob", sha: "blob-1" },
			{ path: "pkg/gone.go", mode: "100644", type: "blob", sha: null },
			{ path: "pkg/new.go", mode: "100644", type: "blob", sha: "blob-2" },
			{
				path: "scripts/run.sh",
				mode: "100755",
				type: "blob",
				sha: "blob-3",
			},
		]);
		expect(fake.called("git.createCommit")[0]).toMatchObject({
			message: "the message",
			tree: "tree-new",
			parents: [repo.sha],
		});
		expect(fake.called("git.createRef")[0]).toMatchObject({
			ref: "refs/heads/fixloop/issue-5",
			sha: "commit-new",
		});
	});

	it("delivers a rename as a delete plus an add", async () => {
		const { diff } = await diffOf(repo, async (dir) => {
			await exec("git", ["mv", "pkg/gone.go", "pkg/moved.go"], {
				cwd: dir,
			});
		});

		expect(diff).toContain("rename from");

		const result = await commitFixBranch({
			root: repo.root,
			headSha: repo.sha,
			diff,
			branch: "b",
			message: "m",
		});

		expect(result.files).toEqual([
			{ path: "pkg/gone.go", status: "deleted" },
			{ path: "pkg/moved.go", status: "added" },
		]);
	});

	it("rejects a diff that does not apply, and writes nothing", async () => {
		const fake = fakeOctokit();

		await expect(
			commitFixBranch({
				root: repo.root,
				headSha: repo.sha,
				diff: fix.diff.replace("return 1", "return 99"),
				branch: "b",
				message: "m",
				write: {
					octokit: fake.octokit,
					repo: { owner: "o", repo: "r" },
				},
			}),
		).rejects.toThrow();
		expect(fake.writes()).toEqual([]);
	});
});

describe("labels", () => {
	it("labelsFor follows the delivery, severity and area", () => {
		expect(
			labelsFor("ready_pr", { severity: "S1", area: "frontend" }),
		).toEqual(["fixloop", "fixloop:ready", "sev:S1", "area:frontend"]);
		expect(
			labelsFor(
				"draft_pr",
				{ severity: "S4", area: "unknown" },
				"backend",
			),
		).toEqual(["fixloop", "fixloop:draft", "sev:S4", "area:backend"]);
		expect(labelsFor("draft_pr", undefined)).toEqual([
			"fixloop",
			"fixloop:draft",
		]);
	});

	it("ensureLabels creates the missing ones with a colour and ignores an already-exists race", async () => {
		const fake = fakeOctokit({ labels: ["fixloop"] });

		const created = await ensureLabels(
			fake.octokit,
			{ owner: "o", repo: "r" },
			["fixloop", "sev:S2", "area:frontend"],
		);

		expect(created).toEqual(["sev:S2", "area:frontend"]);
		expect(fake.called("issues.createLabel")[0]).toMatchObject({
			name: "sev:S2",
			color: "d93f0b",
		});

		const raced = fakeOctokit();

		raced.octokit.issues.createLabel = (async () => {
			throw Object.assign(new Error("already_exists"), { status: 422 });
		}) as never;

		expect(
			await ensureLabels(raced.octokit, { owner: "o", repo: "r" }, [
				"fixloop",
			]),
		).toEqual([]);
	});
});
