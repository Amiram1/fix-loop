import type { Dirent } from "node:fs";
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolHandler } from "../agent/client.js";

/** Directories no tool lists, searches or reads. `.fixloop` holds our own cached briefs. */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set([
	".git",
	"node_modules",
	"vendor",
	".fixloop",
]);

export const MAX_READ_BYTES = 60 * 1024;
export const MAX_GREP_MATCHES = 100;

const MAX_LIST_ENTRIES = 500;

const MAX_LINE_CHARS = 2000;

const MAX_MATCH_CHARS = 240;

const MAX_FILE_BYTES = 5 * 1024 * 1024;

const MAX_GREP_FILE_BYTES = 1024 * 1024;

const BINARY_SNIFF_BYTES = 8000;

/** Thrown for a miss the model can act on. Handlers turn it into a plain "error: ..." string. */
class ToolError extends Error {}

const isInside = (root: string, target: string): boolean => {
	const rel = path.relative(root, target);

	return (
		rel === "" ||
		!(
			rel === ".." ||
			rel.startsWith(`..${path.sep}`) ||
			path.isAbsolute(rel)
		)
	);
};

const toPosix = (p: string) => p.split(path.sep).join("/");

const relFrom = (root: string, p: string) =>
	toPosix(path.relative(root, p)) || ".";

/**
 * Resolves a model-supplied path against `root`. Rejects anything that leaves the root, either
 * lexically (`..`, absolute paths) or through a symlink, and anything under a skipped directory.
 * Returns the real path so later reads cannot be redirected by a symlink in the middle.
 */
async function resolveInRoot(root: string, input: string): Promise<string> {
	const candidate = path.resolve(root, input);

	if (!isInside(root, candidate)) {
		throw new ToolError(`path "${input}" is outside the repository`);
	}

	let real: string;

	try {
		real = await realpath(candidate);
	} catch {
		throw new ToolError(`no such file or directory: ${input}`);
	}

	if (!isInside(root, real)) {
		throw new ToolError(
			`path "${input}" resolves outside the repository (symlink)`,
		);
	}

	const skipped = path
		.relative(root, real)
		.split(path.sep)
		.find((part) => SKIPPED_DIRS.has(part));

	if (skipped) {
		throw new ToolError(`"${skipped}" directories are not available`);
	}

	return real;
}

async function isBinaryFile(file: string): Promise<boolean> {
	const handle = await open(file, "r");

	try {
		const buf = Buffer.alloc(BINARY_SNIFF_BYTES);

		const { bytesRead } = await handle.read(buf, 0, BINARY_SNIFF_BYTES, 0);

		return buf.subarray(0, bytesRead).includes(0);
	} finally {
		await handle.close();
	}
}

const clip = (s: string, max: number) =>
	s.length > max ? `${s.slice(0, max)}...[line truncated]` : s;

const pathInput = z.object({ path: z.string().default(".") });

const readInput = z.object({
	path: z.string().min(1),
	offset: z.number().int().min(1).optional(),
	limit: z.number().int().min(1).optional(),
});

const grepInput = z.object({
	pattern: z.string().min(1),
	path: z.string().default("."),
});

async function listDir(root: string, input: unknown): Promise<string> {
	const args = pathInput.parse(input ?? {});

	const dir = await resolveInRoot(root, args.path);

	if (!(await stat(dir)).isDirectory()) {
		throw new ToolError(`not a directory: ${args.path}`);
	}

	const entries = (await readdir(dir, { withFileTypes: true }))
		.filter((e) => !SKIPPED_DIRS.has(e.name))
		.sort((a, b) => a.name.localeCompare(b.name));

	const lines = entries.slice(0, MAX_LIST_ENTRIES).map((e) => {
		if (e.isDirectory()) return `${e.name}/`;

		return e.isSymbolicLink() ? `${e.name} (symlink)` : e.name;
	});

	if (entries.length > MAX_LIST_ENTRIES) {
		lines.push(
			`[${entries.length - MAX_LIST_ENTRIES} more entries not shown]`,
		);
	}

	return lines.length > 0 ? lines.join("\n") : "(empty directory)";
}

async function readFileTool(root: string, input: unknown): Promise<string> {
	const args = readInput.parse(input);

	const file = await resolveInRoot(root, args.path);

	const info = await stat(file);

	if (!info.isFile()) throw new ToolError(`not a file: ${args.path}`);

	if (info.size > MAX_FILE_BYTES) {
		throw new ToolError(
			`file is too large to read (${info.size} bytes); use grep to find the part you need`,
		);
	}

	if (await isBinaryFile(file)) {
		throw new ToolError(`binary file, not shown: ${args.path}`);
	}

	const lines = (await readFile(file, "utf8")).split("\n");

	// A trailing newline yields one empty last element that is not a real line.
	if (lines.at(-1) === "") lines.pop();

	const first = args.offset ?? 1;

	if (lines.length === 0) return "(empty file)";

	if (first > lines.length) {
		throw new ToolError(
			`offset ${first} is past the end of the file (${lines.length} lines)`,
		);
	}

	const wanted = lines.slice(
		first - 1,
		args.limit ? first - 1 + args.limit : undefined,
	);

	const out: string[] = [];

	let bytes = 0;

	for (const [i, line] of wanted.entries()) {
		const text = `${first + i}\t${clip(line, MAX_LINE_CHARS)}`;

		bytes += Buffer.byteLength(text) + 1;

		if (bytes > MAX_READ_BYTES) break;

		out.push(text);
	}

	const last = first + out.length - 1;

	const cutByBytes = out.length < wanted.length;

	if (cutByBytes) {
		out.push(
			`[truncated at ${MAX_READ_BYTES} bytes: showed lines ${first}-${last} of ${lines.length}; call read_file with offset=${last + 1} to continue]`,
		);
	} else if (last < lines.length) {
		out.push(
			`[showed lines ${first}-${last} of ${lines.length}; call read_file with offset=${last + 1} to continue]`,
		);
	}

	return out.join("\n");
}

/** Compiles the model's pattern as a regex, falling back to a literal match when it is not one. */
function compilePattern(pattern: string): RegExp {
	try {
		return new RegExp(pattern);
	} catch {
		return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	}
}

async function* walkFiles(dir: string): AsyncGenerator<string> {
	let entries: Dirent[];

	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}

	entries.sort((a, b) => a.name.localeCompare(b.name));

	for (const e of entries) {
		if (SKIPPED_DIRS.has(e.name)) continue;

		const full = path.join(dir, e.name);

		// Symlinks are never followed while walking: no loops and no way out of the root.
		if (e.isDirectory()) yield* walkFiles(full);
		else if (e.isFile()) yield full;
	}
}

async function grepTool(root: string, input: unknown): Promise<string> {
	const args = grepInput.parse(input);

	const start = await resolveInRoot(root, args.path);

	const re = compilePattern(args.pattern);

	const files = (await stat(start)).isDirectory()
		? walkFiles(start)
		: (async function* () {
				yield start;
			})();

	const matches: string[] = [];

	let capped = false;

	search: for await (const file of files) {
		try {
			const { size } = await stat(file);

			if (size > MAX_GREP_FILE_BYTES || (await isBinaryFile(file))) {
				continue;
			}
		} catch {
			continue;
		}

		const lines = (await readFile(file, "utf8")).split("\n");

		for (const [i, line] of lines.entries()) {
			// Testing a bounded slice keeps a pathological regex from running on a huge line.
			if (!re.test(line.slice(0, MAX_LINE_CHARS))) continue;

			if (matches.length >= MAX_GREP_MATCHES) {
				capped = true;
				break search;
			}

			matches.push(
				`${relFrom(root, file)}:${i + 1}: ${clip(line.trim(), MAX_MATCH_CHARS)}`,
			);
		}
	}

	if (matches.length === 0) return "no matches";

	if (capped) {
		matches.push(
			`[stopped at ${MAX_GREP_MATCHES} matches; narrow the pattern or path]`,
		);
	}

	return matches.join("\n");
}

function handler(
	root: string,
	definition: ToolHandler["definition"],
	run: (root: string, input: unknown) => Promise<string>,
): ToolHandler {
	return {
		definition,
		run: async (input) => {
			try {
				// Resolved per call so a root that is itself a symlink is compared by its real path.
				return await run(await realpath(root), input);
			} catch (err) {
				if (err instanceof z.ZodError) {
					return `error: invalid arguments (${err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")})`;
				}

				return `error: ${(err as Error).message}`;
			}
		},
	};
}

/**
 * Read-only tools over the tree at `root` (list_dir, read_file, grep). Paths are relative to
 * the root; anything that resolves outside it is refused. Misses come back as "error: ..."
 * strings for the model rather than thrown errors.
 */
export function createRepoTools(root: string): ToolHandler[] {
	return [
		handler(
			root,
			{
				name: "list_dir",
				description:
					"List the entries of a directory in the repository. Directories end with '/'. Omits .git, node_modules and vendor.",
				input_schema: {
					type: "object",
					properties: {
						path: {
							type: "string",
							description:
								"Directory relative to the repository root. Defaults to the root.",
						},
					},
				},
			},
			listDir,
		),
		handler(
			root,
			{
				name: "read_file",
				description: `Read a text file with line numbers. Output is capped at about ${MAX_READ_BYTES / 1024} KB; the reply says when it was cut and which offset continues. Binary files are refused.`,
				input_schema: {
					type: "object",
					properties: {
						path: {
							type: "string",
							description:
								"File relative to the repository root.",
						},
						offset: {
							type: "integer",
							description:
								"First line to read, 1-based. Defaults to 1.",
						},
						limit: {
							type: "integer",
							description:
								"Maximum number of lines to read. Defaults to the whole file (subject to the size cap).",
						},
					},
					required: ["path"],
				},
			},
			readFileTool,
		),
		handler(
			root,
			{
				name: "grep",
				description: `Search text files for a JavaScript regular expression (a pattern that is not a valid regex is matched literally). Returns path:line: text, at most ${MAX_GREP_MATCHES} matches. Skips .git, node_modules, vendor and binary files.`,
				input_schema: {
					type: "object",
					properties: {
						pattern: {
							type: "string",
							description: "Regex or plain text to look for.",
						},
						path: {
							type: "string",
							description:
								"File or directory to search, relative to the repository root. Defaults to the whole repository.",
						},
					},
					required: ["pattern"],
				},
			},
			grepTool,
		),
	];
}
