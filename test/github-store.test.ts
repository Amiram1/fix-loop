import type { Octokit } from "@octokit/rest";
import { describe, expect, it } from "vitest";
import { githubDataStore } from "../src/data/github.js";

const REPO = { owner: "o", repo: "r" };

const httpError = (status: number) =>
	Object.assign(new Error(`HTTP ${status}`), { status });

type Args = Record<string, unknown>;

/** The slice of the GitHub API the store uses, kept in memory. Nothing here touches the network. */
function fakeGitHub(
	opts: { branches?: string[]; files?: Record<string, string> } = {},
) {
	const branches = new Set(opts.branches ?? []);

	// path -> text, on every branch (the tests only use one)
	const files = new Map(Object.entries(opts.files ?? {}));

	const shas = new Map([...files.keys()].map((p) => [p, `sha-${p}`]));

	const calls: [string, Args][] = [];

	let version = 0;

	const call = (name: string, args: Args) => calls.push([name, args]);

	const octokit = {
		git: {
			getRef: async (a: Args) => {
				call("git.getRef", a);

				if (!branches.has(String(a.ref).replace("heads/", "")))
					throw httpError(404);

				return { data: {} };
			},
			createTree: async (a: Args) => {
				call("git.createTree", a);

				return { data: { sha: "tree-sha" } };
			},
			createCommit: async (a: Args) => {
				call("git.createCommit", a);

				return { data: { sha: "commit-sha" } };
			},
			createRef: async (a: Args) => {
				call("git.createRef", a);
				branches.add(String(a.ref).replace("refs/heads/", ""));

				return { data: {} };
			},
		},
		repos: {
			getContent: async (a: Args) => {
				call("repos.getContent", a);

				const path = String(a.path);

				if (!branches.has(String(a.ref))) throw httpError(404);

				const text = files.get(path);

				if (text !== undefined) {
					const b64 = Buffer.from(text).toString("base64");

					return {
						data: {
							type: "file",
							path,
							sha: shas.get(path),
							// GitHub wraps base64 content at 60 characters.
							content: b64.replace(/(.{60})/g, "$1\n"),
						},
					};
				}

				const entries = new Map<
					string,
					{ type: string; path: string }
				>();

				for (const file of files.keys()) {
					if (!file.startsWith(`${path}/`)) continue;

					const [first] = file.slice(path.length + 1).split("/");

					const child = `${path}/${first}`;

					entries.set(child, {
						type: child === file ? "file" : "dir",
						path: child,
					});
				}

				if (!entries.size) throw httpError(404);

				return { data: [...entries.values()].reverse() };
			},
			createOrUpdateFileContents: async (a: Args) => {
				call("repos.createOrUpdateFileContents", a);

				const path = String(a.path);

				if (files.has(path) && a.sha !== shas.get(path)) {
					throw httpError(a.sha ? 409 : 422);
				}

				files.set(
					path,
					Buffer.from(String(a.content), "base64").toString(),
				);
				shas.set(path, `v${++version}`);

				return { data: { content: { sha: shas.get(path) } } };
			},
		},
	};

	return {
		octokit: octokit as unknown as Octokit,
		calls,
		files,
		branches,
		named: (name: string) =>
			calls.filter(([n]) => n === name).map(([, a]) => a),
	};
}

describe("githubDataStore: read", () => {
	it("decodes the base64 content, from the data branch", async () => {
		const gh = fakeGitHub({
			branches: ["fixloop-data"],
			files: { "ledger/runs.jsonl": `${"é".repeat(80)}\nline 2\n` },
		});

		const store = githubDataStore(gh.octokit, REPO);

		expect(await store.read("ledger/runs.jsonl")).toBe(
			`${"é".repeat(80)}\nline 2\n`,
		);
		expect(gh.named("repos.getContent")[0]).toEqual({
			...REPO,
			path: "ledger/runs.jsonl",
			ref: "fixloop-data",
		});
	});

	it("returns undefined on 404, for a missing file or a missing branch", async () => {
		const withBranch = fakeGitHub({ branches: ["fixloop-data"] });

		expect(
			await githubDataStore(withBranch.octokit, REPO).read(
				"journal/1.json",
			),
		).toBeUndefined();

		const noBranch = fakeGitHub();

		expect(
			await githubDataStore(noBranch.octokit, REPO).read(
				"journal/1.json",
			),
		).toBeUndefined();
	});

	it("passes other errors through", async () => {
		const gh = fakeGitHub({ branches: ["fixloop-data"] });

		gh.octokit.repos.getContent = (async () => {
			throw httpError(500);
		}) as never;

		await expect(
			githubDataStore(gh.octokit, REPO).read("journal/1.json"),
		).rejects.toThrow("HTTP 500");
	});

	it("rejects paths that could leave the store", async () => {
		const store = githubDataStore(fakeGitHub().octokit, REPO);

		await expect(store.read("../secrets")).rejects.toThrow(
			/invalid data path/,
		);
		await expect(store.write("/etc/passwd", "x")).rejects.toThrow(
			/invalid data path/,
		);
		await expect(store.list("a/../b")).rejects.toThrow(/invalid data path/);
	});
});

describe("githubDataStore: write", () => {
	it("creates a file without a sha when it is not there", async () => {
		const gh = fakeGitHub({ branches: ["fixloop-data"] });

		await githubDataStore(gh.octokit, REPO).write(
			"journal/1.json",
			"héllo",
		);

		const [put] = gh.named("repos.createOrUpdateFileContents");

		expect(put).toMatchObject({
			...REPO,
			path: "journal/1.json",
			branch: "fixloop-data",
			content: Buffer.from("héllo").toString("base64"),
		});
		expect(put?.sha).toBeUndefined();
		expect(gh.files.get("journal/1.json")).toBe("héllo");
	});

	it("updates an existing file with its current sha", async () => {
		const gh = fakeGitHub({
			branches: ["fixloop-data"],
			files: { "journal/1.json": "old" },
		});

		await githubDataStore(gh.octokit, REPO).write("journal/1.json", "new");

		expect(gh.named("repos.createOrUpdateFileContents")[0]?.sha).toBe(
			"sha-journal/1.json",
		);
		expect(gh.files.get("journal/1.json")).toBe("new");
	});

	it("appends over a file it read, and again after its own write", async () => {
		const gh = fakeGitHub({
			branches: ["fixloop-data"],
			files: { "ledger/runs.jsonl": "a\n" },
		});

		const store = githubDataStore(gh.octokit, REPO);

		await store.write(
			"ledger/runs.jsonl",
			`${await store.read("ledger/runs.jsonl")}b\n`,
		);
		await store.write(
			"ledger/runs.jsonl",
			`${await store.read("ledger/runs.jsonl")}c\n`,
		);

		expect(gh.files.get("ledger/runs.jsonl")).toBe("a\nb\nc\n");
	});

	it("fails instead of overwriting a file that changed since it was read", async () => {
		const gh = fakeGitHub({
			branches: ["fixloop-data"],
			files: { "ledger/runs.jsonl": "a\n" },
		});

		const store = githubDataStore(gh.octokit, REPO);

		await store.read("ledger/runs.jsonl");

		// Someone else commits in between.
		await githubDataStore(gh.octokit, REPO).write(
			"ledger/runs.jsonl",
			"a\nother\n",
		);

		await expect(
			store.write("ledger/runs.jsonl", "a\nmine\n"),
		).rejects.toThrow("HTTP 409");
		expect(gh.files.get("ledger/runs.jsonl")).toBe("a\nother\n");
	});
});

describe("githubDataStore: list", () => {
	it("returns file paths under the prefix, sorted and including nested ones", async () => {
		const gh = fakeGitHub({
			branches: ["fixloop-data"],
			files: {
				"journal/2.json": "",
				"journal/1.json": "",
				"journal/old/9.json": "",
				"ledger/runs.jsonl": "",
			},
		});

		expect(await githubDataStore(gh.octokit, REPO).list("journal")).toEqual(
			["journal/1.json", "journal/2.json", "journal/old/9.json"],
		);
	});

	it("lists nothing for an unknown prefix or a missing branch", async () => {
		expect(
			await githubDataStore(
				fakeGitHub({ branches: ["fixloop-data"] }).octokit,
				REPO,
			).list("journal"),
		).toEqual([]);
		expect(
			await githubDataStore(fakeGitHub().octokit, REPO).list("journal"),
		).toEqual([]);
	});
});

describe("githubDataStore: ensureBranch", () => {
	it("creates an orphan branch before the first write when it is missing", async () => {
		const gh = fakeGitHub();

		const store = githubDataStore(gh.octokit, REPO);

		await store.write("journal/1.json", "x");
		await store.write("journal/2.json", "y");

		expect(gh.calls.map(([name]) => name)).toEqual([
			"git.getRef",
			"git.createTree",
			"git.createCommit",
			"git.createRef",
			"repos.getContent",
			"repos.createOrUpdateFileContents",
			"repos.getContent",
			"repos.createOrUpdateFileContents",
		]);
		// The first tree holds a README: GitHub rejects an empty tree.
		expect(gh.named("git.createTree")[0]).toMatchObject({
			...REPO,
			tree: [expect.objectContaining({ path: "README.md" })],
		});
		expect(gh.named("git.createCommit")[0]).toMatchObject({
			tree: "tree-sha",
			parents: [],
		});
		expect(gh.named("git.createRef")[0]).toEqual({
			...REPO,
			ref: "refs/heads/fixloop-data",
			sha: "commit-sha",
		});
		expect(gh.files.get("journal/2.json")).toBe("y");
	});

	it("creates nothing when the branch exists", async () => {
		const gh = fakeGitHub({ branches: ["fixloop-data"] });

		await githubDataStore(gh.octokit, REPO).write("journal/1.json", "x");

		expect(gh.named("git.getRef")).toHaveLength(1);
		expect(gh.named("git.createTree")).toHaveLength(0);
		expect(gh.named("git.createRef")).toHaveLength(0);
	});

	it("does not create the branch for a read or a list", async () => {
		const gh = fakeGitHub();

		const store = githubDataStore(gh.octokit, REPO);

		await store.read("journal/1.json");
		await store.list("journal");

		expect(gh.named("git.createRef")).toHaveLength(0);
		expect(gh.branches.size).toBe(0);
	});

	it("uses the branch it is given", async () => {
		const gh = fakeGitHub();

		await githubDataStore(gh.octokit, REPO, "custom-data").write(
			"a.txt",
			"x",
		);

		expect(gh.named("git.createRef")[0]?.ref).toBe(
			"refs/heads/custom-data",
		);
		expect(gh.named("repos.createOrUpdateFileContents")[0]?.branch).toBe(
			"custom-data",
		);
	});

	it("does not write when the branch cannot be created", async () => {
		const gh = fakeGitHub();

		gh.octokit.git.createRef = (async () => {
			throw httpError(403);
		}) as never;

		await expect(
			githubDataStore(gh.octokit, REPO).write("a.txt", "x"),
		).rejects.toThrow("HTTP 403");
		expect(gh.named("repos.createOrUpdateFileContents")).toHaveLength(0);
	});
});
