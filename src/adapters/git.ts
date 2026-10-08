import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** The commit currently checked out at `root`. Used as the brief cache key. */
export async function headSha(root: string): Promise<string> {
	const { stdout } = await execFileP("git", ["rev-parse", "HEAD"], {
		cwd: root,
	});

	return stdout.trim();
}
