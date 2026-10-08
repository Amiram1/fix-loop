import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { collectDiff } from "../../src/fix/git.js";
import {
	createScratchCheckout,
	removeScratchCheckout,
} from "../../src/repro/workspace.js";

const exec = promisify(execFile);

export interface FixRepo {
	root: string;
	/** Full sha of the commit the fix applies to. */
	sha: string;
	cleanup: () => Promise<void>;
}

/** A temp git repo with one commit, written by `email`. Files are path to content. */
export async function makeRepo(
	files: Record<string, string>,
	email = "alice@x.test",
): Promise<FixRepo> {
	const root = await mkdtemp(join(tmpdir(), "fixloop-deliver-"));

	await exec("git", ["init", "-q"], { cwd: root });

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
			"init",
		],
		{ cwd: root },
	);

	const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: root });

	return {
		root,
		sha: stdout.trim(),
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}

/** Makes `edit` changes in a scratch checkout, the way the Fix stage does, and returns the diff. */
export async function diffOf(
	repo: FixRepo,
	edit: (dir: string) => Promise<void>,
) {
	const dir = await createScratchCheckout(repo.root, repo.sha);

	try {
		await edit(dir);

		return await collectDiff(dir, "no-such-file");
	} finally {
		await removeScratchCheckout(dir);
	}
}

export async function write(dir: string, path: string, content: string) {
	await mkdir(dirname(join(dir, path)), { recursive: true });
	await writeFile(join(dir, path), content);
}
