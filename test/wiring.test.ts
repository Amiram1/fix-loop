import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Octokit } from "@octokit/rest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { briefFingerprint, headSha } from "../src/adapters/git.js";
import { listOpenIssues } from "../src/adapters/github.js";
import { parseConfig } from "../src/config/load.js";
import { buildStages } from "../src/pipeline/stages.js";
import { stagesFor } from "../src/pipeline/wiring.js";

const exec = promisify(execFile);

const config = parseConfig(`
app:
  up: x
  base_url: http://localhost:3456
tests:
  full: make test
`);

describe("buildStages", () => {
	it("runs Intake, Context, Boot, then the pending stages, in that order", () => {
		const stages = buildStages({
			client: {
				create: async () => {
					throw new Error("not called at construction");
				},
			},
			budget: {
				spentUsd: 0,
				limitUsd: 1,
				record() {},
				assertCanSpend() {},
			} as never,
			store: { get: async () => undefined, put: async () => {} },
			root: "/tmp",
			headSha: "abc",
		});

		expect(stages.map((s) => s.name)).toEqual([
			"Intake",
			"Context",
			"Boot",
			"Reproduce",
			"Fix",
			"Deliver",
		]);
	});
});

describe("stagesFor", () => {
	it("refuses to build a pipeline without an API key", async () => {
		await expect(
			stagesFor({ root: "/tmp", config, apiKey: undefined }),
		).rejects.toThrow(/ANTHROPIC_API_KEY/);
	});
});

describe("headSha", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "fixloop-git-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("returns the checked-out commit", async () => {
		await exec("git", ["init", "-q"], { cwd: dir });
		await writeFile(join(dir, "a.txt"), "a");
		await exec("git", ["add", "."], { cwd: dir });
		await exec(
			"git",
			[
				"-c",
				"user.name=t",
				"-c",
				"user.email=t@t",
				"commit",
				"-qm",
				"init",
			],
			{ cwd: dir },
		);

		const { stdout } = await exec("git", ["rev-parse", "HEAD"], {
			cwd: dir,
		});

		expect(await headSha(dir)).toBe(stdout.trim());
	});
});

describe("listOpenIssues", () => {
	it("drops pull requests and caps the list", async () => {
		const octokit = {
			issues: {
				listForRepo: async () => ({
					data: [
						{ number: 1, title: "bug one" },
						{
							number: 2,
							title: "a pull request",
							pull_request: {},
						},
						{ number: 3, title: "bug three" },
					],
				}),
			},
		} as unknown as Octokit;

		const issues = await listOpenIssues(
			octokit,
			{ owner: "o", repo: "r", issue: 9 },
			1,
		);

		expect(issues).toEqual([{ number: 1, title: "bug one" }]);
	});
});

describe("briefFingerprint", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "fixloop-fp-"));
		await exec("git", ["init", "-q"], { cwd: dir });
		await writeFile(join(dir, "main.go"), "package main\n");
		await writeFile(join(dir, "go.mod"), "module x\n");
		await exec("git", ["add", "."], { cwd: dir });
		await exec(
			"git",
			[
				"-c",
				"user.name=t",
				"-c",
				"user.email=t@t",
				"commit",
				"-qm",
				"init",
			],
			{ cwd: dir },
		);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("stays the same for an ordinary source edit, and changes for a manifest or a new file", async () => {
		const before = await briefFingerprint(dir);

		await writeFile(join(dir, "main.go"), "package main\n// edited\n");
		expect(await briefFingerprint(dir)).toBe(before);

		await writeFile(join(dir, "go.mod"), "module y\n");

		const afterManifest = await briefFingerprint(dir);

		expect(afterManifest).not.toBe(before);

		await exec("git", ["add", "."], { cwd: dir });
		await writeFile(join(dir, "new.go"), "package main\n");
		await exec("git", ["add", "."], { cwd: dir });
		expect(await briefFingerprint(dir)).not.toBe(afterManifest);
	});
});
