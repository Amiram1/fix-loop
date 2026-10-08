import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localDataStore, safeDataPath } from "../src/memory/datastore.js";

describe("localDataStore", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "fixloop-data-"));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("round-trips text and lists nested paths", async () => {
		const store = localDataStore(root);

		expect(await store.read("journal/1.json")).toBeUndefined();

		await store.write("journal/1.json", "{}");
		await store.write("journal/sub/2.json", "[]");

		expect(await store.read("journal/1.json")).toBe("{}");
		expect(await store.list("journal")).toEqual([
			"journal/1.json",
			"journal/sub/2.json",
		]);
		expect(await store.list("nothing")).toEqual([]);
	});

	it("refuses paths that could leave the store", () => {
		expect(() => safeDataPath("../escape")).toThrow(/invalid/);
		expect(() => safeDataPath("/etc/passwd")).toThrow(/invalid/);
		expect(() => safeDataPath("a/../../b")).toThrow(/invalid/);
		expect(safeDataPath("ledger/runs.jsonl")).toBe("ledger/runs.jsonl");
	});
});
