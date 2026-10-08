import { describe, expect, it } from "vitest";
import { parseRepoSlug, parseRunArgs, UsageError } from "../src/cli/run.js";

describe("parseRunArgs", () => {
	it("requires a positive integer issue", () => {
		expect(() => parseRunArgs([])).toThrow(UsageError);
		expect(() => parseRunArgs(["--issue", "abc"])).toThrow(
			/positive integer/,
		);
		expect(() => parseRunArgs(["--issue", "0"])).toThrow(
			/positive integer/,
		);
	});

	it("applies defaults", () => {
		expect(parseRunArgs(["--issue", "12"])).toEqual({
			issue: 12,
			repo: undefined,
			config: ".fixloop.yml",
			dev: false,
			dryRun: false,
			stage: undefined,
		});
	});

	it("parses flags", () => {
		const opts = parseRunArgs([
			"--issue",
			"3",
			"--repo",
			"acme/app",
			"--config",
			"x.yml",
			"--dev",
			"--dry-run",
			"--stage",
			"Fix",
		]);

		expect(opts).toMatchObject({
			issue: 3,
			repo: "acme/app",
			config: "x.yml",
			dev: true,
			dryRun: true,
			stage: "Fix",
		});
	});

	it("rejects unknown flags and malformed repos", () => {
		expect(() => parseRunArgs(["--issue", "1", "--nope"])).toThrow(
			UsageError,
		);
		expect(() =>
			parseRunArgs(["--issue", "1", "--repo", "justname"]),
		).toThrow(/owner\/name/);
	});
});

describe("parseRepoSlug", () => {
	it.each([
		["https://github.com/Amiram1/fix-loop.git", "Amiram1/fix-loop"],
		["git@github.com:Amiram1/fix-loop.git", "Amiram1/fix-loop"],
		["https://github.com/Amiram1/fix-loop", "Amiram1/fix-loop"],
	])("parses %s", (url, slug) => {
		expect(parseRepoSlug(url)).toBe(slug);
	});

	it("returns undefined for non-GitHub remotes", () => {
		expect(parseRepoSlug("https://gitlab.com/a/b.git")).toBeUndefined();
	});
});
