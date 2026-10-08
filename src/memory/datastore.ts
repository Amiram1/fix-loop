import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Durable text the pipeline keeps between runs: journal entries and the run ledger. Paths are
 * repo-relative style ("journal/12.json"). Only the local-directory store exists so far; the
 * `fixloop-data` branch of the target repo comes next.
 */
export interface DataStore {
	/** The text at `path`, or undefined when there is none. */
	read: (path: string) => Promise<string | undefined>;
	write: (path: string, text: string) => Promise<void>;
	/** Files under `prefix`, sorted. An unknown prefix lists nothing. */
	list: (prefix: string) => Promise<string[]>;
}

const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** Rejects anything that could name a file outside the store. */
export function safeDataPath(value: string): string {
	if (!SAFE_PATH.test(value) || value.split("/").includes("..")) {
		throw new Error(`invalid data path "${value}"`);
	}

	return value;
}

/** Keeps data in `<root>/.fixloop/data/<path>`. The `.fixloop` directory is git-ignored. */
export function localDataStore(root: string): DataStore {
	const base = path.join(root, ".fixloop", "data");

	return {
		read: async (file) => {
			try {
				return await readFile(
					path.join(base, safeDataPath(file)),
					"utf8",
				);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT")
					return undefined;

				throw err;
			}
		},
		write: async (file, text) => {
			const target = path.join(base, safeDataPath(file));

			await mkdir(path.dirname(target), { recursive: true });
			await writeFile(target, text);
		},
		list: async (prefix) => {
			const dir = path.join(base, safeDataPath(prefix));

			try {
				const entries = await readdir(dir, {
					recursive: true,
					withFileTypes: true,
				});

				return entries
					.filter((entry) => entry.isFile())
					.map((entry) => {
						const inside = path.relative(
							dir,
							path.join(entry.parentPath, entry.name),
						);

						return path.posix.join(
							prefix,
							inside.split(path.sep).join("/"),
						);
					})
					.sort();
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];

				throw err;
			}
		},
	};
}
