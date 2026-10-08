import type { DataStore } from "../../src/memory/datastore.js";

/** An in-memory DataStore, with the files exposed so a test can see what was written where. */
export function memoryDataStore(): DataStore & { files: Map<string, string> } {
	const files = new Map<string, string>();

	return {
		files,
		read: async (file) => files.get(file),
		write: async (file, text) => void files.set(file, text),
		list: async (prefix) =>
			[...files.keys()].filter((f) => f.startsWith(prefix)).sort(),
	};
}
