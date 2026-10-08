import { join, posix } from "node:path";
import { run } from "../boot/exec.js";
import type { FixLoopConfig } from "../config/schema.js";
import {
	type AreaRunner,
	type Classification,
	isSafeName,
	safeRelativePath,
	substitute,
	type TestRun,
} from "./runner.js";

const TEST_TIMEOUT_MS = 10 * 60 * 1000;

const HINTS = [
	"Backend tests are Go. Read one existing *_test.go next to the code you test and copy its package name and style.",
	"Create the new test file in the same directory and package as the code it exercises, using the standard `testing` package (testify assert/require is available).",
	"Name the test function TestRepro<Something>. The name must be unique in that package, so do not reuse an existing test name.",
	"Assert the CORRECT behaviour directly on a returned value, so the test fails on the bug. Never write an assertion that expects the buggy result.",
	"Keep setup minimal and call the code directly; avoid starting services. Every import must be used, or the build fails. Do not modify existing files.",
].join("\n");

export function backendRunner(config: FixLoopConfig): AreaRunner | undefined {
	const backend = config.tests.backend;

	if (!backend) return undefined;

	return {
		area: "backend",
		testGlob: backend.new_test_glob,
		hints: HINTS,
		runTest: async ({ file, name }, ctx) => {
			const rel = safeRelativePath(file);

			if (!rel || !isSafeName(name)) {
				throw new Error("unsafe test file or name");
			}

			const result = await run(
				substitute(backend.run, {
					name,
					file: rel,
					dir: posix.dirname(rel),
				}),
				{
					cwd: join(ctx.checkout, backend.dir),
					env: ctx.env,
					timeoutMs: TEST_TIMEOUT_MS,
				},
			);

			return {
				exitCode: result.code,
				output: result.stdout + result.stderr,
			};
		},
		classify,
	};
}

// "# pkg" header, [build failed]/[setup failed], or an unindented "file.go:12:5: ..." compiler line.
// Test log lines are indented, so they never match the last pattern.
const BUILD_ERROR =
	/\[(?:build|setup) failed\]|^# \S+|^\S*\.go:\d+(?::\d+)?: /m;

const FAILED_TEST = /^\s*--- FAIL: /m;

/** First stack frame after the panic that is not Go runtime or testing code, to see who panicked. */
function panicSite(output: string): string | undefined {
	return output
		.split(/^goroutine \d+ \[running\]:$/m)[1]
		?.split("\n")
		.filter((line) => /^\s+\S+\.go:\d+/.test(line))
		.find(
			(line) =>
				!/^\s+(?:.*\/src\/)?(?:runtime|testing)\/[^/]+\.go:/.test(line),
		);
}

export function classify({ exitCode, output }: TestRun): Classification {
	if (/no test files|no Go files/.test(output)) {
		return {
			red: false,
			reason: "no test files in that directory; the test file is not where the command looks",
		};
	}

	if (BUILD_ERROR.test(output)) {
		const line = output.split("\n").find((l) => /^\S*\.go:\d+/.test(l));

		return {
			red: false,
			reason: `the test does not build or set up${line ? `: ${line}` : ""}; fix it`,
		};
	}

	if (exitCode === 0) {
		return {
			red: false,
			reason: /no tests to run/.test(output)
				? "no test matched the name"
				: "the test passed, so it does not show the bug",
		};
	}

	if (!FAILED_TEST.test(output)) {
		return {
			red: false,
			reason: "the command failed but no test reported a failure (--- FAIL:)",
		};
	}

	if (
		/nil pointer dereference/.test(output) &&
		panicSite(output)?.includes("_test.go")
	) {
		return {
			red: false,
			reason: "the test panicked on a nil pointer in its own code; fix its setup",
		};
	}

	return { red: true, reason: "the test failed on an assertion" };
}
