import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Files whose contents change what a brief says: dependencies, build, and repo conventions. */
export const MANIFEST_FILES = [
	"go.mod",
	"package.json",
	"Dockerfile",
	"README.md",
	"AGENTS.md",
	"CLAUDE.md",
	".fixloop.yml",
];

/** The commit currently checked out at `root`. Used to check out the exact tree for Reproduce. */
export async function headSha(root: string): Promise<string> {
	const { stdout } = await execFileP("git", ["rev-parse", "HEAD"], {
		cwd: root,
	});

	return stdout.trim();
}

/**
 * Brief cache fingerprint: the tracked file list plus the manifest files. It changes when files
 * are added, removed or renamed, or when a manifest changes. It does not change on ordinary edits,
 * so routine commits reuse the brief instead of paying to regenerate it.
 */
export async function briefFingerprint(root: string): Promise<string> {
	const { stdout } = await execFileP("git", ["ls-files", "-z"], {
		cwd: root,
		maxBuffer: 64 * 1024 * 1024,
	});

	const hash = createHash("sha256").update(stdout);

	for (const name of MANIFEST_FILES) {
		try {
			hash.update(name)
				.update("\0")
				.update(await readFile(join(root, name)));
		} catch {
			// Absent in this repo: nothing to add.
		}
	}

	return hash.digest("hex");
}
