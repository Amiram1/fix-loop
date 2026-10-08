import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const MAX_DIFF_BYTES = 16 * 1024 * 1024;

/**
 * The change made in a scratch checkout, as a unified diff, excluding the red test. Stages
 * everything first so new files are included. Only the scratch index is touched.
 */
export async function collectDiff(
	checkout: string,
	excludePath: string,
): Promise<{ diff: string; files: string[] }> {
	await execFileP("git", ["add", "-A"], { cwd: checkout });

	const pathspec = [".", `:(exclude)${excludePath}`];

	const names = await execFileP(
		"git",
		["diff", "--cached", "--name-only", "--", ...pathspec],
		{ cwd: checkout },
	);

	const diff = await execFileP(
		"git",
		["diff", "--cached", "--no-color", "--", ...pathspec],
		{ cwd: checkout, maxBuffer: MAX_DIFF_BYTES },
	);

	return {
		diff: diff.stdout,
		files: names.stdout.split("\n").filter((line) => line.length > 0),
	};
}
