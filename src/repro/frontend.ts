import { access } from "node:fs/promises";
import { join, posix } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { type Exec, run } from "../boot/exec.js";
import type { FixLoopConfig } from "../config/schema.js";
import {
	type AreaRunner,
	type Classification,
	isSafeName,
	safeRelativePath,
	substitute,
	type TestRun,
	tail,
} from "./runner.js";

const INSTALL_TIMEOUT_MS = 15 * 60_000;

const TEST_TIMEOUT_MS = 10 * 60_000;

const HINTS = [
	"Frontend tests use Vitest. Look at an existing frontend/src/helpers/*.test.ts first and copy its style: `import {describe, it, expect} from 'vitest'`, then import the code under test with a relative path.",
	"Prefer testing a pure helper directly (call the function, assert on its return value). Avoid mounting components or booting the app unless the bug cannot be shown otherwise.",
	"Name the top-level describe (or the it) with the prefix `TestRepro`, e.g. describe('TestReproStorageSize', ...). Pass that same name to run_test; `file` is the repo-relative path, e.g. frontend/src/helpers/storageSize.test.ts.",
	"Assert the CORRECT behaviour with expect(...).toBe/toEqual, so the test fails with an assertion error while the bug is present. An import error, a missing export or a typo is NOT red.",
].join("\n");

// Load and syntax failures win over assertion markers: a broken test must never count as the bug.
const NOT_A_RUN: [RegExp, string][] = [
	[/No test files? found/i, "no test file was found; check the path"],
	[
		/SyntaxError|Transform failed|Failed to parse source/,
		"the test file has a syntax error",
	],
	[
		/Failed to load|Failed to resolve import|Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND/,
		"the test file or one of its imports failed to load",
	],
	[
		/ReferenceError/,
		"the test hit a ReferenceError (undefined name), not an assertion",
	],
	[
		/TypeError: .*is not a (?:function|constructor)/,
		"the test called something that is not a function (wrong import or name?)",
	],
	[/No test suite found/i, "the file contains no test suite"],
];

const ASSERTION =
	/AssertionError|\bexpected\b.+\bto (?:be|equal|deeply equal|strictly equal|match|contain|include|have|throw)\b|^\s*(?:[-+]\s*)?(?:Expected|Received)\b/m;

export function classifyFrontend(run: TestRun): Classification {
	if (run.exitCode === 0) {
		return {
			red: false,
			reason: "the test passed, so it does not show the bug",
		};
	}

	const output = stripVTControlCharacters(run.output);

	for (const [pattern, reason] of NOT_A_RUN) {
		if (pattern.test(output)) return { red: false, reason };
	}

	if (ASSERTION.test(output)) {
		return { red: true, reason: "the test failed on an assertion" };
	}

	return {
		red: false,
		reason: "the run failed without an assertion failure; fix the test",
	};
}

/** Makes a repo-relative path relative to the command's working directory (the config `dir`). */
export function relativeToDir(file: string, dir: string): string {
	const rel = posix.relative(posix.normalize(dir), file);

	if (rel.startsWith("..") || posix.isAbsolute(rel)) {
		throw new Error(`${file} is not inside the frontend dir ${dir}`);
	}

	return rel;
}

export function frontendRunner(
	config: FixLoopConfig,
	exec: Exec = run,
): AreaRunner | undefined {
	const frontend = config.tests.frontend;

	if (!frontend) return undefined;

	const cwd = (checkout: string) => join(checkout, frontend.dir);

	return {
		area: "frontend",
		testGlob: frontend.new_test_glob,
		hints: HINTS,
		prepare: async (ctx) => {
			const dir = cwd(ctx.checkout);

			const installed = await access(join(dir, "node_modules")).then(
				() => true,
				() => false,
			);

			if (installed) return;

			const result = await exec("pnpm install --frozen-lockfile", {
				cwd: dir,
				env: ctx.env,
				timeoutMs: INSTALL_TIMEOUT_MS,
			});

			if (result.code !== 0) {
				throw new Error(
					`pnpm install failed (exit ${result.code}): ${tail(result.stderr || result.stdout)}`,
				);
			}
		},
		runTest: async ({ file, name }, ctx) => {
			if (!isSafeName(name)) throw new Error(`unsafe test name: ${name}`);

			const repoFile = safeRelativePath(file);

			if (!repoFile) throw new Error(`unsafe test file: ${file}`);

			const rel = relativeToDir(repoFile, frontend.dir);

			const command = substitute(frontend.run, {
				name,
				file: rel,
				dir: posix.dirname(rel),
			});

			const result = await exec(command, {
				cwd: cwd(ctx.checkout),
				env: ctx.env,
				timeoutMs: TEST_TIMEOUT_MS,
			});

			return {
				exitCode: result.code,
				output: `${result.stdout}\n${result.stderr}`.trim(),
			};
		},
		classify: classifyFrontend,
	};
}
