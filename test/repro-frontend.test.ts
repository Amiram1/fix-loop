import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecOptions, ExecResult } from "../src/boot/exec.js";
import { parseConfig } from "../src/config/load.js";
import {
	classifyFrontend,
	frontendRunner,
	relativeToDir,
} from "../src/repro/frontend.js";

const config = parseConfig(`
app:
  up: x
  base_url: http://localhost:3456
tests:
  frontend:
    run: pnpm vitest run {{file}} -t {{name}}
    dir: frontend
    new_test_glob: "frontend/src/**/*.test.ts"
  full: make test
`);

/** Records every command instead of running it. */
function fakeExec(result: Partial<ExecResult> = {}) {
	const calls: { cmd: string; opts?: ExecOptions }[] = [];

	const exec = async (cmd: string, opts?: ExecOptions) => {
		calls.push({ cmd, opts });
		return { code: 0, stdout: "", stderr: "", ...result };
	};

	return { exec, calls };
}

const fail = (output: string) => ({ exitCode: 1, output });

const TEST = { file: "frontend/src/helpers/x.test.ts", name: "TestRepro" };

const classifyFor = (run: { exitCode: number; output: string }) =>
	classifyFrontend(run, TEST);

describe("classifyFrontend", () => {
	it("is red on a Vitest assertion failure", () => {
		const verdict = classifyFor(
			fail(
				" FAIL  src/x.test.ts > TestRepro > size\nAssertionError: expected '2.05 KB' to be '2 KB' // Object.is equality",
			),
		);

		expect(verdict.red).toBe(true);
	});

	it("is red on an Expected/Received diff, with colour codes", () => {
		const verdict = classifyFor(
			fail(
				"FAIL  src/x.test.ts > TestRepro\n\u001b[31m- Expected\u001b[39m\n\u001b[32m+ Received\u001b[39m",
			),
		);

		expect(verdict.red).toBe(true);
	});

	it("is not red when the failing test is a different one", () => {
		const verdict = classifyFor(
			fail(
				"FAIL  src/x.test.ts > TestSomethingElse\nAssertionError: expected 1 to be 2",
			),
		);

		expect(verdict.red).toBe(false);
		expect(verdict.reason).toMatch(/does not name TestRepro/);
	});

	it.each([
		["SyntaxError: Unexpected token"],
		["Error: Failed to load url ../x (resolved id: ../x)"],
		["Error: Cannot find module './nope'"],
		["ReferenceError: foo is not defined"],
		["TypeError: getSize is not a function"],
		["Error: No test suite found in file /x.test.ts"],
		["No test files found, exiting with code 1"],
	])("is not red for a broken test: %s", (output) => {
		const verdict = classifyFor(fail(output));

		expect(verdict.red).toBe(false);
		expect(verdict.reason).not.toBe("");
	});

	it("does not let an assertion marker hide a load failure", () => {
		const verdict = classifyFor(
			fail(
				"AssertionError: expected 1 to be 2\nReferenceError: x is not defined",
			),
		);

		expect(verdict.red).toBe(false);
	});

	it("is not red when the test passed", () => {
		const verdict = classifyFor({
			exitCode: 0,
			output: "Tests  1 passed (1)",
		});

		expect(verdict.red).toBe(false);
		expect(verdict.reason).toMatch(/passed/);
	});

	it("is not red when it failed without any assertion", () => {
		expect(classifyFor(fail("Error: timeout")).red).toBe(false);
	});
});

describe("relativeToDir", () => {
	it("strips the frontend dir", () => {
		expect(relativeToDir("frontend/src/x.test.ts", "frontend")).toBe(
			"src/x.test.ts",
		);
		expect(relativeToDir("frontend/src/x.test.ts", "./frontend/")).toBe(
			"src/x.test.ts",
		);
	});

	it("keeps the path when dir is the repo root", () => {
		expect(relativeToDir("src/x.test.ts", ".")).toBe("src/x.test.ts");
	});

	it("rejects a file outside the dir", () => {
		expect(() => relativeToDir("pkg/x.test.ts", "frontend")).toThrow(
			/not inside/,
		);
	});
});

describe("frontendRunner", () => {
	it("is undefined without tests.frontend", () => {
		const noFrontend = parseConfig(
			"app:\n  up: x\n  base_url: http://localhost:3456\ntests:\n  full: make test\n",
		);

		expect(frontendRunner(noFrontend)).toBeUndefined();
	});

	it("exposes the area and glob from the config", () => {
		const runner = frontendRunner(config);

		expect(runner?.area).toBe("frontend");
		expect(runner?.testGlobs).toEqual(["frontend/src/**/*.test.ts"]);
		expect(runner?.hints).toMatch(/TestRepro/);
	});

	it("runs the command in the frontend dir with a dir-relative file", async () => {
		const { exec, calls } = fakeExec({ stdout: "out", stderr: "err" });

		const result = await frontendRunner(config, exec)?.runTest(
			{ file: "frontend/src/helpers/x.test.ts", name: "TestReproX" },
			{ checkout: "/tmp/co", env: { A: "1" } },
		);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.cmd).toBe(
			"pnpm vitest run src/helpers/x.test.ts -t TestReproX",
		);
		expect(calls[0]?.opts).toMatchObject({
			cwd: "/tmp/co/frontend",
			env: { A: "1" },
			timeoutMs: 600_000,
		});
		expect(result).toEqual({ exitCode: 0, output: "out\nerr" });
	});

	it("substitutes {{dir}} relative to the frontend dir", async () => {
		const { exec, calls } = fakeExec();

		const custom = parseConfig(`
app:
  up: x
  base_url: http://localhost:3456
tests:
  frontend:
    run: vitest {{dir}} {{file}}
    dir: frontend
    new_test_glob: "frontend/**/*.test.ts"
  full: make test
`);

		await frontendRunner(custom, exec)?.runTest(
			{ file: "frontend/src/a/b.test.ts", name: "TestReproB" },
			{ checkout: "/tmp/co", env: {} },
		);

		expect(calls[0]?.cmd).toBe("vitest src/a src/a/b.test.ts");
	});

	it("rejects a shell-hostile name and an escaping path without running anything", async () => {
		const { exec, calls } = fakeExec();

		const runner = frontendRunner(config, exec);

		const ctx = { checkout: "/tmp/co", env: {} };

		await expect(
			runner?.runTest(
				{ file: "frontend/src/x.test.ts", name: "a; rm -rf /" },
				ctx,
			),
		).rejects.toThrow(/unsafe test name/);
		await expect(
			runner?.runTest(
				{ file: "frontend/../../x.test.ts", name: "TestReproX" },
				ctx,
			),
		).rejects.toThrow(/unsafe test file/);
		expect(calls).toHaveLength(0);
	});

	it("installs dependencies once and reports a failed install", async () => {
		const root = await mkdtemp(join(tmpdir(), "fixloop-fe-"));

		try {
			await mkdir(join(root, "frontend"), { recursive: true });

			const failing = fakeExec({ code: 127, stderr: "pnpm: not found" });

			await expect(
				frontendRunner(config, failing.exec)?.prepare?.({
					checkout: root,
					env: {},
				}),
			).rejects.toThrow(
				/pnpm install failed \(exit 127\): pnpm: not found/,
			);
			expect(failing.calls[0]).toMatchObject({
				cmd: "pnpm install --frozen-lockfile",
				opts: { cwd: join(root, "frontend"), timeoutMs: 900_000 },
			});

			await mkdir(join(root, "frontend", "node_modules"));

			const skipped = fakeExec();

			await frontendRunner(config, skipped.exec)?.prepare?.({
				checkout: root,
				env: {},
			});
			expect(skipped.calls).toHaveLength(0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
