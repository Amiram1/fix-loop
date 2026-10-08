import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

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
	return dir;
}

export async function removeScratchCheckout(
	root: string,
	dir: string,
): Promise<void> {
	await execFileP("git", ["worktree", "remove", "--force", dir], {
		cwd: root,
	}).catch(() => undefined);
	await rm(dir, { recursive: true, force: true });
}
