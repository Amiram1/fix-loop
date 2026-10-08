import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubLoginLookup, reviewerFor } from "../src/deliver/owners.js";

const exec = promisify(execFile);

let root: string;

let n = 0;

async function commit(email: string, files: Record<string, string>) {
	for (const [path, content] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), content);
	}

	await exec("git", ["add", "-A"], { cwd: root });
	await exec(
		"git",
		[
			"-c",
			"user.name=t",
			"-c",
			`user.email=${email}`,
			"commit",
			"-qm",
			`c${n++}`,
		],
		{ cwd: root },
	);
}

const logins: Record<string, string> = {
	"alice@x.test": "alice",
	"bob@x.test": "bob",
	"carol@x.test": "Carol",
};

const lookup = vi.fn(async (email: string) => logins[email]);

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "fixloop-owners-"));
	await exec("git", ["init", "-q"], { cwd: root });
	lookup.mockClear();
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("CODEOWNERS", () => {
	const codeowners = [
		"# default owner",
		"*                  @everyone",
		"/pkg/              @backend-dev @backend-two",
		"pkg/models/*.go    @models-dev  # inline comment",
		"docs/              @docs-dev",
		"/web/**/*.ts       @web-dev",
		"/pkg/models/task.go @task-owner",
		"/pkg/legacy/       ",
		"/team/             @org/team @after-team",
		"/emails/           someone@example.com",
		"",
	].join("\n");

	const owner = async (file: string, extra: { issueAuthor?: string } = {}) =>
		(
			await reviewerFor({
				root,
				changedFiles: [file],
				...extra,
			})
		).reviewer;

	beforeEach(async () => {
		await commit("alice@x.test", {
			".github/CODEOWNERS": codeowners,
			"README.md": "x",
		});
	});

	it("matches a catch-all, a directory, a glob and nested paths", async () => {
		expect(await owner("README.md")).toBe("everyone");
		expect(await owner("pkg/web/handler.go")).toBe("backend-dev");
		expect(await owner("pkg/models/user.go")).toBe("models-dev");
		expect(await owner("pkg/models/sub/user.go")).toBe("backend-dev");
		expect(await owner("some/deep/docs/guide.md")).toBe("docs-dev");
		expect(await owner("web/src/a/b.ts")).toBe("web-dev");
		expect(await owner("web/b.ts")).toBe("web-dev");
	});

	it("the last matching rule wins", async () => {
		expect(await owner("pkg/models/task.go")).toBe("task-owner");
	});

	it("skips the issue author and takes the next owner on the rule", async () => {
		expect(
			await owner("pkg/web/handler.go", { issueAuthor: "Backend-Dev" }),
		).toBe("backend-two");
	});

	it("takes the first changed file that has a usable owner", async () => {
		const result = await reviewerFor({
			root,
			changedFiles: ["pkg/legacy/old.go", "docs/a.md"],
		});

		// pkg/legacy has a rule with no owners, so that file has none; the next file does.
		expect(result.reviewer).toBe("docs-dev");
	});

	it("ignores team and email owners", async () => {
		expect(await owner("team/a.go")).toBe("after-team");

		const result = await reviewerFor({
			root,
			changedFiles: ["emails/a.go"],
		});

		expect(result.reviewer).toBeUndefined();
	});

	it("falls back to git when the only owner is the issue author", async () => {
		await commit("bob@x.test", { "docs/only.md": "x" });

		const result = await reviewerFor({
			root,
			changedFiles: ["docs/only.md"],
			issueAuthor: "docs-dev",
			lookupLogin: lookup,
		});

		expect(result.reviewer).toBe("bob");
	});

	it("uses CODEOWNERS at the root and in docs when .github has none", async () => {
		await rm(join(root, ".github"), { recursive: true });
		await commit("alice@x.test", { CODEOWNERS: "* @root-owner\n" });
		expect(await owner("a.go")).toBe("root-owner");

		await rm(join(root, "CODEOWNERS"));
		await commit("alice@x.test", { "docs/CODEOWNERS": "* @docs-owner\n" });
		expect(await owner("a.go")).toBe("docs-owner");
	});

	it("prefers .github/CODEOWNERS over the others", async () => {
		await commit("alice@x.test", { CODEOWNERS: "* @root-owner\n" });

		expect(await owner("README.md")).toBe("everyone");
	});
});

describe("git fallback", () => {
	it("picks the most frequent author of the changed files", async () => {
		await commit("alice@x.test", { "a.go": "1", "b.go": "1" });
		await commit("bob@x.test", { "a.go": "2" });
		await commit("bob@x.test", { "b.go": "2" });
		await commit("alice@x.test", { "c.go": "1" });

		const result = await reviewerFor({
			root,
			changedFiles: ["a.go", "b.go"],
			lookupLogin: lookup,
		});

		expect(result).toEqual({
			reviewer: "bob",
			reason: "most frequent author in git history",
		});
	});

	it("counts only the changed files", async () => {
		await commit("alice@x.test", { "a.go": "1" });
		await commit("bob@x.test", { "other.go": "1" });
		await commit("bob@x.test", { "other.go": "2" });

		const result = await reviewerFor({
			root,
			changedFiles: ["a.go"],
			lookupLogin: lookup,
		});

		expect(result.reviewer).toBe("alice");
	});

	it("skips the issue author and takes the next committer", async () => {
		await commit("alice@x.test", { "a.go": "1" });
		await commit("bob@x.test", { "a.go": "2" });
		await commit("bob@x.test", { "a.go": "3" });

		const result = await reviewerFor({
			root,
			changedFiles: ["a.go"],
			issueAuthor: "@Bob",
			lookupLogin: lookup,
		});

		expect(result.reviewer).toBe("alice");
	});

	it("tries the next committer when an email has no GitHub account", async () => {
		await commit("alice@x.test", { "a.go": "1" });
		await commit("ghost@x.test", { "a.go": "2" });
		await commit("ghost@x.test", { "a.go": "3" });

		const result = await reviewerFor({
			root,
			changedFiles: ["a.go"],
			lookupLogin: lookup,
		});

		expect(result.reviewer).toBe("alice");
		expect(lookup).toHaveBeenCalledTimes(2);
	});

	it("returns no reviewer and says why when the lookup throws", async () => {
		await commit("alice@x.test", { "a.go": "1" });

		const result = await reviewerFor({
			root,
			changedFiles: ["a.go"],
			lookupLogin: async () => {
				throw new Error("rate limited");
			},
		});

		expect(result.reviewer).toBeUndefined();
		expect(result.reason).toContain("rate limited");
	});

	it("returns no reviewer and says why when no email has a login", async () => {
		await commit("ghost@x.test", { "a.go": "1" });

		const result = await reviewerFor({
			root,
			changedFiles: ["a.go"],
			lookupLogin: async () => undefined,
		});

		expect(result.reviewer).toBeUndefined();
		expect(result.reason).toContain("no top committer");
	});

	it("says why when there is no lookup", async () => {
		await commit("alice@x.test", { "a.go": "1" });

		const result = await reviewerFor({ root, changedFiles: ["a.go"] });

		expect(result.reviewer).toBeUndefined();
		expect(result.reason).toContain("no GitHub lookup");
	});

	it("says why for files with no history", async () => {
		await commit("alice@x.test", { "a.go": "1" });

		const result = await reviewerFor({
			root,
			changedFiles: ["brand-new.go"],
			lookupLogin: lookup,
		});

		expect(result.reviewer).toBeUndefined();
		expect(result.reason).toContain("no git history");
	});
});

describe("githubLoginLookup", () => {
	const octokit = (items: { login: string }[]) => {
		const users = vi.fn(async () => ({ data: { items } }));

		return {
			users,
			client: { search: { users } } as unknown as Parameters<
				typeof githubLoginLookup
			>[0],
		};
	};

	it("reads the login from a noreply address without calling GitHub", async () => {
		const { users, client } = octokit([]);

		const lookupLogin = githubLoginLookup(client);

		expect(await lookupLogin("123+octo@users.noreply.github.com")).toBe(
			"octo",
		);
		expect(await lookupLogin("octo@users.noreply.github.com")).toBe("octo");
		expect(
			await lookupLogin("49+dependabot[bot]@users.noreply.github.com"),
		).toBeUndefined();
		expect(users).not.toHaveBeenCalled();
	});

	it("searches by email otherwise", async () => {
		const { users, client } = octokit([{ login: "found" }]);

		expect(await githubLoginLookup(client)("a@x.test")).toBe("found");
		expect(users).toHaveBeenCalledWith({
			q: "a@x.test in:email",
			per_page: 1,
		});
	});

	it("is undefined when the search finds no one", async () => {
		const { client } = octokit([]);

		expect(await githubLoginLookup(client)("a@x.test")).toBeUndefined();
	});
});
