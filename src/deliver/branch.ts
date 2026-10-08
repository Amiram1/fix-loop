import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Octokit } from "@octokit/rest";
import type { RepoRef } from "../adapters/github.js";
import {
	createScratchCheckout,
	removeScratchCheckout,
} from "../repro/workspace.js";

const execFileP = promisify(execFile);

const MAX_BYTES = 64 * 1024 * 1024;

export const branchName = (issue: number) => `fixloop/issue-${issue}`;

export interface FileChange {
	path: string;
	status: "added" | "modified" | "deleted";
}

export const FIXLOOP_AUTHOR = {
	name: "FixLoop",
	email: "fixloop@users.noreply.github.com",
};

export interface BranchResult {
	branch: string;
	files: FileChange[];
	/** Set when the commit was created on GitHub. */
	commitSha?: string;
}

export interface BranchOptions {
	root: string;
	headSha: string;
	/** The fix as a unified diff, as the Fix stage produced it. */
	diff: string;
	branch: string;
	message: string;
	/** Without this nothing is sent anywhere: the diff is applied locally and the files are listed. */
	write?: { octokit: Octokit; repo: RepoRef };
}

interface Change extends FileChange {
	mode: string;
	blob: string;
}

const NUL = String.fromCharCode(0);

/**
 * Applies the fix on a clean clone and, when `write` is given, commits it to `branch` through the
 * Git Data API: blobs, a tree on top of the base commit's tree, a commit, and the ref. The change is
 * built locally with git, and nothing is pushed, so no token ever goes into a git URL.
 * An existing branch is moved to the new commit, because the branch belongs to FixLoop.
 */
export async function commitFixBranch(
	opts: BranchOptions,
): Promise<BranchResult> {
	const dir = await createScratchCheckout(opts.root, opts.headSha);

	try {
		const applying = execFileP(
			"git",
			["apply", "--whitespace=nowarn", "-"],
			{
				cwd: dir,
			},
		);

		applying.child.stdin?.end(opts.diff);
		await applying;
		await execFileP("git", ["add", "-A"], { cwd: dir });

		// Built from the index, not from the diff, so a rename arrives as a delete plus an add.
		const { stdout: raw } = await execFileP(
			"git",
			["diff", "--cached", "--no-renames", "--raw", "--no-abbrev", "-z"],
			{ cwd: dir, maxBuffer: MAX_BYTES },
		);

		const changes = parseRaw(raw);

		const files = changes.map(({ path, status }) => ({ path, status }));

		if (!opts.write) return { branch: opts.branch, files };

		const { octokit, repo } = opts.write;

		const git = (...args: string[]) =>
			execFileP("git", args, { cwd: dir }).then((r) => r.stdout.trim());

		const parent = await git("rev-parse", "HEAD");

		const baseTree = await git("rev-parse", "HEAD^{tree}");

		const tree = [];

		for (const change of changes) {
			if (change.status === "deleted") {
				tree.push({
					path: change.path,
					mode: change.mode as "100644",
					type: "blob" as const,
					sha: null,
				});
				continue;
			}

			const { stdout } = await execFileP(
				"git",
				["cat-file", "blob", change.blob],
				{ cwd: dir, encoding: "buffer", maxBuffer: MAX_BYTES },
			);

			const { data } = await octokit.git.createBlob({
				...repo,
				content: stdout.toString("base64"),
				encoding: "base64",
			});

			tree.push({
				path: change.path,
				mode: change.mode as "100644",
				type: "blob" as const,
				sha: data.sha,
			});
		}

		const { data: newTree } = await octokit.git.createTree({
			...repo,
			base_tree: baseTree,
			tree,
		});

		const { data: commit } = await octokit.git.createCommit({
			...repo,
			message: opts.message,
			tree: newTree.sha,
			parents: [parent],
			author: FIXLOOP_AUTHOR,
			committer: FIXLOOP_AUTHOR,
		});

		await moveBranch(octokit, repo, opts.branch, commit.sha);

		return { branch: opts.branch, files, commitSha: commit.sha };
	} finally {
		await removeScratchCheckout(dir);
	}
}

/** Parses `git diff --raw -z`: ":oldmode newmode oldsha newsha S" NUL path NUL, repeated. */
function parseRaw(raw: string): Change[] {
	const parts = raw.split(NUL);

	const changes: Change[] = [];

	for (let i = 0; i + 1 < parts.length; i += 2) {
		const [, newMode = "", , newSha = "", code = ""] = (
			parts[i] ?? ""
		).split(" ");

		const path = parts[i + 1] ?? "";

		if (newMode === "160000") {
			throw new Error(`cannot deliver a change to the submodule ${path}`);
		}

		const status =
			code === "A" ? "added" : code === "D" ? "deleted" : "modified";

		changes.push({
			path,
			status,
			// A deleted file has mode 000000, and the tree entry for it only needs a regular mode.
			mode: status === "deleted" ? "100644" : newMode,
			blob: newSha,
		});
	}

	return changes;
}

async function moveBranch(
	octokit: Octokit,
	repo: RepoRef,
	branch: string,
	sha: string,
): Promise<void> {
	let exists = true;

	try {
		await octokit.git.getRef({ ...repo, ref: `heads/${branch}` });
	} catch (err) {
		if ((err as { status?: number }).status !== 404) throw err;

		exists = false;
	}

	if (exists) {
		await octokit.git.updateRef({
			...repo,
			ref: `heads/${branch}`,
			sha,
			force: true,
		});
	} else {
		await octokit.git.createRef({
			...repo,
			ref: `refs/heads/${branch}`,
			sha,
		});
	}
}

/** Whether the branch exists on GitHub. */
async function refExists(
	octokit: Octokit,
	repo: RepoRef,
	branch: string,
): Promise<boolean> {
	try {
		await octokit.git.getRef({ ...repo, ref: `heads/${branch}` });
		return true;
	} catch (err) {
		if ((err as { status?: number }).status === 404) return false;

		throw err;
	}
}

/**
 * Why this change cannot be delivered, or undefined when it can. Reads GitHub but writes nothing.
 * An existing branch is never overwritten when it holds commits that FixLoop did not make, and a
 * binary file or submodule cannot be carried by the commit path yet.
 */
export async function deliveryRefusal(opts: {
	diff: string;
	branch: string;
	headSha: string;
	octokit?: Octokit;
	repo?: RepoRef;
}): Promise<string | undefined> {
	if (
		/^[+-]Subproject commit |^Binary files |^GIT binary patch/m.test(
			opts.diff,
		)
	) {
		return "the change includes a binary file or a submodule, which a pull request cannot carry yet";
	}

	if (!opts.octokit || !opts.repo) return undefined;

	if (!(await refExists(opts.octokit, opts.repo, opts.branch)))
		return undefined;

	const { data } = await opts.octokit.repos.compareCommits({
		...opts.repo,
		base: opts.headSha,
		head: opts.branch,
	});

	const human = data.commits.filter(
		(commit) => commit.commit.author?.name !== FIXLOOP_AUTHOR.name,
	);

	if (human.length > 0) {
		return `branch ${opts.branch} has ${human.length} commit(s) not made by FixLoop, so it is not overwritten`;
	}

	return undefined;
}
