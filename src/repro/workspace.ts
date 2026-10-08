import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Scratch checkouts not removed yet. */
const active = new Set<string>();

/**
 * A self-contained clone of `root` at `sha`, in a temp directory. Reproduce and Fix work here, so
 * the user's checkout is never modified.
 *
 * It is a clone, not a git worktree, on purpose: a worktree's `.git` is a file that points back at
 * the main repo, which is not in a Docker build context. Vikunja's image build calls `git describe`,
 * and that fails inside a worktree. A clone carries its own git data. Hardlinks are off so the copy
 * does not depend on the source repo's object store.
 */
export async function createScratchCheckout(
	root: string,
	sha: string,
): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "fixloop-repro-"));

	active.add(dir);

	await execFileP("git", [
		"clone",
		"--quiet",
		"--no-hardlinks",
		"--no-checkout",
		root,
		dir,
	]);
	await execFileP("git", ["checkout", "--quiet", "--detach", sha], {
		cwd: dir,
	});

	return dir;
}

export async function removeScratchCheckout(dir: string): Promise<void> {
	active.delete(dir);
	await rm(dir, { recursive: true, force: true });
}

/**
 * Removes every scratch checkout still open. Used on SIGINT/SIGTERM, because `finally` blocks
 * do not run when the process exits from a signal.
 */
export async function removeAllScratchCheckouts(): Promise<void> {
	await Promise.all([...active].map((dir) => removeScratchCheckout(dir)));
}
