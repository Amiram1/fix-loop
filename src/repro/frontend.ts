import { access } from "node:fs/promises";
import { join, matchesGlob, posix } from "node:path";
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

const BROWSER_INSTALL_TIMEOUT_MS = 10 * 60_000;

/** With e2e configured, the e2e hints already say when a unit test is the right tool. */
function vitestHints(alsoE2e: boolean): string {
	return [
		"Frontend unit tests use Vitest. Look at an existing frontend/src/helpers/*.test.ts first and copy its style: `import {describe, it, expect} from 'vitest'`, then import the code under test with a relative path.",
		alsoE2e
			? undefined
			: "Prefer testing a pure helper directly (call the function, assert on its return value). Avoid mounting components or booting the app unless the bug cannot be shown otherwise.",
		"Name the top-level describe (or the it) with the prefix `TestRepro`, e.g. describe('TestReproStorageSize', ...). Pass that same name to run_test; `file` is the repo-relative path, e.g. frontend/src/helpers/storageSize.test.ts.",
		"Assert the CORRECT behaviour with expect(...).toBe/toEqual, so the test fails with an assertion error while the bug is present. An import error, a missing export or a typo is NOT red.",
	]
		.filter((line) => line !== undefined)
		.join("\n");
}

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

export function classifyFrontend(
	run: TestRun,
	test: { file: string; name: string },
): Classification {
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

	if (!output.includes(test.name)) {
		return {
			red: false,
			reason: `the failure does not name ${test.name}; the failing test is not the one written`,
		};
	}

	if (ASSERTION.test(output)) {
		return { red: true, reason: "the test failed on an assertion" };
	}

	return {
		red: false,
		reason: "the run failed without an assertion failure; fix the test",
	};
}

type E2eConfig = NonNullable<FixLoopConfig["tests"]["e2e"]>;

function e2eHints(e2e: E2eConfig, alsoVitest: boolean): string {
	const names = Object.keys(e2e.env);

	return [
		alsoVitest
			? "Policy: reproduce what the reporter saw, where they saw it. If the report describes something on a page (a list, a label, a button, a value shown on screen), the reproduction MUST be a Playwright spec that drives the real UI against the running app. Do not write a Vitest unit test for it, even when you already see the helper behind the symptom: that proves the helper, not the screen. Use Vitest only when the report is about a function or calculation and mentions no page."
			: "Tests are Playwright specs that drive the real UI against the running app.",
		`Create the spec under ${e2e.new_test_glob} (repo-relative path). Look at one existing *.spec.ts first and copy its imports and style.`,
		"The app is already running. Its address is in process.env.BASE_URL (the Playwright config normally uses it as baseURL, so page.goto('/') works).",
		names.length > 0
			? `Log in through the UI with ${names.map((n) => `process.env.${n}`).join(" and ")}. Read them at run time, never write their values into the file.`
			: "Log in through the UI if the page needs it.",
		"Set data up through the UI, or through page.request calls to the app's API once logged in. Keep the test short: one test per file, one thing asserted.",
		"Find elements with page.getByTestId (the app's data-cy attributes; grep the source for them), then roles and text. Avoid CSS selectors.",
		"Give the test a unique title with the prefix `TestRepro`, e.g. test('TestReproStorageSize', ...). Pass that same name to run_test; it is used as a regex, so use only letters, digits and underscores.",
		"Assert the CORRECT behaviour with a web-first assertion, e.g. await expect(locator).toHaveText('2 KB'), so the test fails on an assertion while the bug is present. A timeout waiting for an element, a failed login, a wrong selector or a navigation error is NOT red.",
	].join("\n");
}

// Environment, syntax and import failures win over assertion markers: a broken run must never count as the bug.
const E2E_NOT_A_RUN: [RegExp, string][] = [
	[
		/No tests found/i,
		"no test matched; check the file path and that the test title contains the name",
	],
	[
		/Executable doesn't exist|browserType\.launch|download new browsers/,
		"the browser is not installed; this is an environment problem, not the bug",
	],
	[
		/net::ERR_|ECONNREFUSED/,
		"the page was not reachable; the app is down or BASE_URL is wrong, not the bug",
	],
	[/SyntaxError/, "the spec file has a syntax error"],
	[
		/Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND/,
		"the spec file or one of its imports failed to load",
	],
	[
		/ReferenceError/,
		"the test hit a ReferenceError (undefined name), not an assertion",
	],
	[/TypeError:/, "the test code threw a TypeError, not an assertion"],
];

// A failed Playwright assertion prints `Error: expect(...)` and then Expected/Received lines.
const E2E_ASSERTION =
	/Error: expect\(|AssertionError|^\s*Expected(?: \w+)?:|^\s*Received(?: \w+)?:/m;

const E2E_TIMEOUT = /Timeout \d+ms exceeded|Test timeout of \d+ms exceeded/;

export function classifyE2e(
	run: TestRun,
	test: { file: string; name: string },
): Classification {
	if (run.exitCode === 0) {
		return {
			red: false,
			reason: "the test passed, so it does not show the bug",
		};
	}

	const output = stripVTControlCharacters(run.output);

	for (const [pattern, reason] of E2E_NOT_A_RUN) {
		if (pattern.test(output)) return { red: false, reason };
	}

	if (!output.includes(test.name)) {
		return {
			red: false,
			reason: `the failure does not name ${test.name}; the failing test is not the one written`,
		};
	}

	if (E2E_ASSERTION.test(output)) {
		return { red: true, reason: "the test failed on an assertion" };
	}

	if (E2E_TIMEOUT.test(output)) {
		return {
			red: false,
			reason: "the test timed out waiting for something it never found (a locator, a page or a login) and no assertion failed; that is a broken test, not a shown bug. Fix the selector, login or navigation",
		};
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
	const { frontend, e2e } = config.tests;

	if (!frontend && !e2e) return undefined;

	/** The e2e config when `file` is an e2e spec; it wins when both globs match. */
	const e2eFor = (file: string) =>
		e2e && matchesGlob(file, e2e.new_test_glob) ? e2e : undefined;

	const dirs = new Set(
		[frontend?.dir, e2e?.dir].filter((dir) => dir !== undefined),
	);

	return {
		area: "frontend",
		testGlobs: [frontend?.new_test_glob, e2e?.new_test_glob].filter(
			(glob) => glob !== undefined,
		),
		hints: [
			e2e ? e2eHints(e2e, frontend !== undefined) : undefined,
			frontend ? vitestHints(e2e !== undefined) : undefined,
		]
			.filter((hint) => hint !== undefined)
			.join("\n\n"),
		prepare: async (ctx) => {
			for (const dir of dirs) {
				const cwd = join(ctx.checkout, dir);

				const installed = await access(join(cwd, "node_modules")).then(
					() => true,
					() => false,
				);

				if (installed) continue;

				const result = await exec("pnpm install --frozen-lockfile", {
					cwd,
					env: ctx.env,
					timeoutMs: INSTALL_TIMEOUT_MS,
				});

				if (result.code !== 0) {
					throw new Error(
						`pnpm install failed (exit ${result.code}): ${tail(result.stderr || result.stdout)}`,
					);
				}
			}

			if (!e2e) return;

			// Idempotent: a browser that is already cached is not downloaded again.
			const result = await exec("pnpm exec playwright install chromium", {
				cwd: join(ctx.checkout, e2e.dir),
				env: ctx.env,
				timeoutMs: BROWSER_INSTALL_TIMEOUT_MS,
			});

			if (result.code !== 0) {
				throw new Error(
					`playwright install chromium failed (exit ${result.code}): ${tail(result.stderr || result.stdout)}`,
				);
			}
		},
		runTest: async ({ file, name }, ctx) => {
			if (!isSafeName(name)) throw new Error(`unsafe test name: ${name}`);

			const repoFile = safeRelativePath(file);

			if (!repoFile) throw new Error(`unsafe test file: ${file}`);

			const e2eTarget = e2eFor(repoFile);

			const target = e2eTarget ?? frontend;

			if (!target) throw new Error(`no test command for ${file}`);

			const rel = relativeToDir(repoFile, target.dir);

			const command = substitute(target.run, {
				name,
				file: rel,
				dir: posix.dirname(rel),
			});

			const result = await exec(command, {
				cwd: join(ctx.checkout, target.dir),
				env: e2eTarget ? e2eEnv(e2eTarget, ctx.env) : ctx.env,
				timeoutMs: TEST_TIMEOUT_MS,
			});

			return {
				exitCode: result.code,
				output: `${result.stdout}\n${result.stderr}`.trim(),
			};
		},
		classify: (run, test) =>
			e2eFor(test.file)
				? classifyE2e(run, test)
				: classifyFrontend(run, test),
		needsApp: (file) => e2eFor(file) !== undefined,
	};
}

/** Run env over the config env. Vikunja-style apps read BASE_URL; FixLoop publishes the booted address as FIXLOOP_BASE_URL. */
function e2eEnv(
	e2e: E2eConfig,
	env: Record<string, string>,
): Record<string, string> {
	const merged = { ...e2e.env, ...env };

	if (env.FIXLOOP_BASE_URL) merged.BASE_URL = env.FIXLOOP_BASE_URL;

	return merged;
}
