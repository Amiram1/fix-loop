// A DataStore over the GitHub contents API: the `fixloop-data` branch of the target repo.
import type { Octokit } from "@octokit/rest";
import type { RepoRef } from "../adapters/github.js";
import { type DataStore, safeDataPath } from "../memory/datastore.js";

export const DATA_BRANCH = "fixloop-data";

const isNotFound = (err: unknown) =>
	(err as { status?: number }).status === 404;

export function githubDataStore(
	octokit: Octokit,
	ref: RepoRef,
	branch = DATA_BRANCH,
): DataStore & { ensureBranch: () => Promise<void> } {
	/** The blob sha each file had when it was last read or written. */
	const shas = new Map<string, string>();

	/** The file's content and sha, or undefined when it is not there. */
	const getFile = async (file: string) => {
		try {
			const { data } = await octokit.repos.getContent({
				...ref,
				path: file,
				ref: branch,
			});

			// ponytail: files over 1 MB come back without content; the ledger gets there after
			// about 1,500 runs. Upgrade to the git blobs API then.
			if (Array.isArray(data) || data.type !== "file") return undefined;

			shas.set(file, data.sha);

			return Buffer.from(data.content, "base64").toString("utf8");
		} catch (err) {
			if (isNotFound(err)) return undefined;

			throw err;
		}
	};

	const ensureBranch = async () => {
		try {
			await octokit.git.getRef({ ...ref, ref: `heads/${branch}` });

			return;
		} catch (err) {
			if (!isNotFound(err)) throw err;
		}

		// An orphan branch: an empty tree and a commit with no parent, so no history from the repo.
		const { data: tree } = await octokit.git.createTree({
			...ref,
			tree: [],
		});

		const { data: commit } = await octokit.git.createCommit({
			...ref,
			message: "fixloop: data branch",
			tree: tree.sha,
			parents: [],
		});

		await octokit.git.createRef({
			...ref,
			ref: `refs/heads/${branch}`,
			sha: commit.sha,
		});
	};

	let branchReady: Promise<void> | undefined;

	const listDir = async (dir: string): Promise<string[]> => {
		let data: Awaited<ReturnType<typeof octokit.repos.getContent>>["data"];

		try {
			({ data } = await octokit.repos.getContent({
				...ref,
				path: dir,
				ref: branch,
			}));
		} catch (err) {
			if (isNotFound(err)) return [];

			throw err;
		}

		if (!Array.isArray(data)) return [];

		const nested = await Promise.all(
			data.map((entry) =>
				entry.type === "dir" ? listDir(entry.path) : [entry.path],
			),
		);

		return nested.flat();
	};

	return {
		ensureBranch,
		read: async (file) => getFile(safeDataPath(file)),
		write: async (file, text) => {
			safeDataPath(file);

			// Once per store, and only a branch that is missing gets created.
			branchReady ??= ensureBranch().catch((err: unknown) => {
				branchReady = undefined;

				throw err;
			});

			await branchReady;

			// A sha from an earlier read makes a write over someone else's change fail loudly
			// (409) instead of silently replacing it. Without one, use the file's current sha.
			if (!shas.has(file)) await getFile(file);

			const { data } = await octokit.repos.createOrUpdateFileContents({
				...ref,
				path: file,
				branch,
				message: `fixloop: update ${file}`,
				content: Buffer.from(text).toString("base64"),
				sha: shas.get(file),
			});

			if (data.content?.sha) shas.set(file, data.content.sha);
		},
		list: async (prefix) =>
			(await listDir(safeDataPath(prefix).replace(/\/+$/, ""))).sort(),
	};
}
