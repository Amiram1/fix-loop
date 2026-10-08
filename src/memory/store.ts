import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Where generated briefs are kept between runs. Only the local-directory store exists so far;
 * a store backed by the `fixloop-data` branch of the target repo (PLAN.md section 3) comes later.
 */
export interface BriefStore {
	/** Returns the stored brief, or undefined when there is none for `key`. */
	get: (key: string) => Promise<string | undefined>;
	put: (key: string, text: string) => Promise<void>;
}

/** Keys become file names, so they must not be able to name another directory. */
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function fileFor(dir: string, key: string): string {
	if (!KEY_PATTERN.test(key)) throw new Error(`invalid brief key "${key}"`);

	return path.join(dir, `${key}.md`);
}

/** Keeps briefs in `<root>/.fixloop/brief/<key>.md`. The directory is git-ignored. */
export function localBriefStore(root: string): BriefStore {
	const dir = path.join(root, ".fixloop", "brief");

	return {
		get: async (key) => {
			try {
				return await readFile(fileFor(dir, key), "utf8");
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") {
					return undefined;
				}

				throw err;
			}
		},
		put: async (key, text) => {
			const file = fileFor(dir, key);

			await mkdir(dir, { recursive: true });

			// Write then rename so a crash never leaves a half-written brief that reads as a hit.
			const tmp = `${file}.${process.pid}.tmp`;

			await writeFile(tmp, text, "utf8");
			await rename(tmp, file);
		},
	};
}
