import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createRepoTools,
	MAX_GREP_MATCHES,
	MAX_READ_BYTES,
} from "../src/memory/tools.js";

let base: string;

let root: string;

let outside: string;

beforeEach(async () => {
	base = await realpath(await mkdtemp(path.join(tmpdir(), "fixloop-tools-")));
	root = path.join(base, "repo");
	outside = path.join(base, "outside");

	await mkdir(path.join(root, "src"), { recursive: true });
	await mkdir(path.join(root, "node_modules/pkg"), { recursive: true });
	await mkdir(path.join(root, "vendor"), { recursive: true });
	await mkdir(path.join(root, ".git"), { recursive: true });
	await mkdir(outside);

	await writeFile(path.join(root, "README.md"), "# Demo\nhello world\n");
	await writeFile(path.join(root, "src/app.ts"), "export const a = 1;\n");
	await writeFile(path.join(root, "node_modules/pkg/index.js"), "hello\n");
	await writeFile(path.join(root, "vendor/lib.go"), "hello\n");
	await writeFile(path.join(root, ".git/config"), "hello\n");
	await writeFile(path.join(outside, "secret.txt"), "hello secret\n");
});

afterEach(() => rm(base, { recursive: true, force: true }));

function tool(name: string) {
	const found = createRepoTools(root).find((t) => t.definition.name === name);

	if (!found) throw new Error(`no tool ${name}`);

	return (input: unknown) => found.run(input);
}

describe("path scoping", () => {
	it("rejects .. escapes and absolute paths outside the root in every tool", async () => {
		const secretPath = path.join(outside, "secret.txt");

		expect(
			await tool("read_file")({ path: "../outside/secret.txt" }),
		).toMatch(/^error: .*outside the repository/);
		expect(await tool("read_file")({ path: secretPath })).toMatch(
			/^error: .*outside the repository/,
		);
		expect(await tool("list_dir")({ path: ".." })).toMatch(
			/^error: .*outside the repository/,
		);
		expect(
			await tool("grep")({ pattern: "hello", path: "../outside" }),
		).toMatch(/^error: .*outside the repository/);
		expect(
			await tool("read_file")({ path: "src/../../outside/secret.txt" }),
		).toMatch(/^error: .*outside the repository/);
	});

	it("rejects a symlink to a file outside the root", async () => {
		await symlink(
			path.join(outside, "secret.txt"),
			path.join(root, "link.txt"),
		);

		const out = await tool("read_file")({ path: "link.txt" });

		expect(out).toMatch(/^error: .*symlink/);
		expect(out).not.toContain("secret");
	});

	it("rejects a symlink to a directory outside the root, for listing, reading and grep", async () => {
		await symlink(outside, path.join(root, "escape"));

		expect(await tool("list_dir")({ path: "escape" })).toMatch(
			/^error: .*symlink/,
		);
		expect(await tool("read_file")({ path: "escape/secret.txt" })).toMatch(
			/^error: .*symlink/,
		);
		expect(
			await tool("grep")({ pattern: "secret", path: "escape" }),
		).toMatch(/^error: .*symlink/);
	});

	it("does not follow symlinks out of the root while searching the whole repo", async () => {
		await symlink(outside, path.join(root, "escape"));

		expect(await tool("grep")({ pattern: "secret" })).toBe("no matches");
	});

	it("allows symlinks that stay inside the root", async () => {
		await symlink(path.join(root, "src"), path.join(root, "alias"));

		expect(await tool("read_file")({ path: "alias/app.ts" })).toContain(
			"export const a = 1;",
		);
	});

	it("accepts an absolute path that is inside the root", async () => {
		expect(
			await tool("read_file")({ path: path.join(root, "src/app.ts") }),
		).toContain("export const a = 1;");
	});

	it("refuses skipped directories", async () => {
		expect(await tool("read_file")({ path: ".git/config" })).toMatch(
			/^error:/,
		);
		expect(await tool("list_dir")({ path: "node_modules" })).toMatch(
			/^error:/,
		);
		expect(await tool("read_file")({ path: "vendor/lib.go" })).toMatch(
			/^error:/,
		);
	});

	it("returns a readable error, not an exception, for a missing path and bad arguments", async () => {
		expect(await tool("read_file")({ path: "nope.txt" })).toMatch(
			/^error: no such file/,
		);
		expect(await tool("read_file")({})).toMatch(
			/^error: invalid arguments/,
		);
		expect(await tool("grep")({ pattern: "" })).toMatch(
			/^error: invalid arguments/,
		);
		expect(await tool("read_file")({ path: "src" })).toMatch(
			/^error: not a file/,
		);
	});
});

describe("list_dir", () => {
	it("lists sorted entries, marks directories and omits skipped ones", async () => {
		expect(await tool("list_dir")({})).toBe("README.md\nsrc/");
		expect(await tool("list_dir")({ path: "src" })).toBe("app.ts");
	});
});

describe("read_file", () => {
	it("numbers lines and honours offset and limit", async () => {
		await writeFile(
			path.join(root, "lines.txt"),
			Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n"),
		);

		const out = await tool("read_file")({
			path: "lines.txt",
			offset: 3,
			limit: 2,
		});

		expect(out).toBe(
			"3\tline3\n4\tline4\n[showed lines 3-4 of 10; call read_file with offset=5 to continue]",
		);
	});

	it("truncates at about 60 KB and says where to continue", async () => {
		const line = "x".repeat(99);

		await writeFile(
			path.join(root, "big.txt"),
			`${Array.from({ length: 2000 }, () => line).join("\n")}\n`,
		);

		const out = await tool("read_file")({ path: "big.txt" });

		expect(Buffer.byteLength(out)).toBeLessThan(MAX_READ_BYTES + 300);
		expect(out).toMatch(
			/\[truncated at 61440 bytes: showed lines 1-\d+ of 2000/,
		);

		const next = /offset=(\d+)/.exec(out)?.[1];

		const rest = await tool("read_file")({
			path: "big.txt",
			offset: Number(next),
			limit: 1,
		});

		expect(rest.startsWith(`${next}\t${line}`)).toBe(true);
	});

	it("cuts a single enormous line instead of returning it whole", async () => {
		await writeFile(path.join(root, "min.js"), "y".repeat(200_000));

		const out = await tool("read_file")({ path: "min.js" });

		expect(out.length).toBeLessThan(3000);
		expect(out).toContain("[line truncated]");
	});

	it("refuses binary files and offsets past the end", async () => {
		await writeFile(path.join(root, "logo.bin"), Buffer.from([1, 2, 0, 3]));

		expect(await tool("read_file")({ path: "logo.bin" })).toMatch(
			/^error: binary/,
		);
		expect(
			await tool("read_file")({ path: "README.md", offset: 99 }),
		).toMatch(/^error: offset 99 is past the end/);
	});
});

describe("grep", () => {
	it("finds regex and literal matches with path and line, skipping ignored dirs", async () => {
		expect(await tool("grep")({ pattern: "hello" })).toBe(
			"README.md:2: hello world",
		);
		expect(await tool("grep")({ pattern: "export const \\w+ = 1" })).toBe(
			"src/app.ts:1: export const a = 1;",
		);

		await writeFile(path.join(root, "src/call.ts"), "run(1)\n");

		// "run(" is not a valid regex, so it is searched literally.
		expect(await tool("grep")({ pattern: "run(" })).toBe(
			"src/call.ts:1: run(1)",
		);
	});

	it("searches a single file and skips binary files", async () => {
		await writeFile(
			path.join(root, "bin.dat"),
			Buffer.from("hello\0hello"),
		);

		expect(await tool("grep")({ pattern: "hello" })).not.toContain(
			"bin.dat",
		);
		expect(
			await tool("grep")({ pattern: "hello", path: "README.md" }),
		).toBe("README.md:2: hello world");
	});

	it("caps the number of matches and says so", async () => {
		await writeFile(
			path.join(root, "many.txt"),
			Array.from({ length: 250 }, (_, i) => `needle ${i}`).join("\n"),
		);

		const out = (await tool("grep")({ pattern: "needle" })).split("\n");

		expect(out).toHaveLength(MAX_GREP_MATCHES + 1);
		expect(out[0]).toBe("many.txt:1: needle 0");
		expect(out.at(-1)).toMatch(/^\[stopped at 100 matches/);
	});

	it("does not report a cap when there are exactly the maximum matches", async () => {
		await writeFile(
			path.join(root, "exact.txt"),
			Array.from({ length: MAX_GREP_MATCHES }, () => "needle").join("\n"),
		);

		const out = (await tool("grep")({ pattern: "needle" })).split("\n");

		expect(out).toHaveLength(MAX_GREP_MATCHES);
	});
});
