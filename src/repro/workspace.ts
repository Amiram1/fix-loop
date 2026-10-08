import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Scratch checkouts not removed yet, by directory, with the repo they belong to. */
const active = new Map<string, string>();

/**
 * A detached git worktree at `sha`, in a temp directory. Reproduce writes its test here, so the
 * user's checkout is never modified. Remove it with removeScratchCheckout.
 */
export async function createScratchCheckout(
	root: string,
	sha: string,
): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "fixloop-repro-"));

	await execFileP("git", ["worktree", "add", "--detach", dir, sha], {
		cwd: root,
	});
	active.set(dir, root);
	return dir;
}

export async function removeScratchCheckout(
	root: string,
	dir: string,
): Promise<void> {
	active.delete(dir);
	await execFileP("git", ["worktree", "remove", "--force", dir], {
		cwd: root,
	}).catch(() => undefined);
	await rm(dir, { recursive: true, force: true });
}

/**
 * Removes every scratch checkout still open. Used on SIGINT/SIGTERM, because `finally` blocks
 * do not run when the process exits from a signal.
 */
export async function removeAllScratchCheckouts(): Promise<void> {
	await Promise.all(
		[...active].map(([dir, root]) => removeScratchCheckout(root, dir)),
	);
}
