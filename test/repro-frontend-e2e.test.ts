import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecOptions, ExecResult } from "../src/boot/exec.js";
import { parseConfig } from "../src/config/load.js";
import { classifyE2e, frontendRunner } from "../src/repro/frontend.js";

const both = parseConfig(`
app:
  up: x
  base_url: http://localhost:3456
tests:
  frontend:
    run: pnpm vitest run {{file}} -t {{name}}
    dir: frontend
    new_test_glob: "frontend/src/**/*.test.ts"
  e2e:
    run: pnpm exec playwright test {{file}} -g {{name}} --reporter=list
    dir: frontend
    new_test_glob: "frontend/tests/e2e/fixloop/*.spec.ts"
    env:
      FIXLOOP_TEST_USER: fixloop
      FIXLOOP_TEST_PASSWORD: secret-pw
  full: make test
`);

const vitestOnly = parseConfig(`
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

const e2eOnly = parseConfig(`
app:
  up: x
  base_url: http://localhost:3456
tests:
  e2e:
    run: pw {{file}} -g {{name}}
    dir: web
    new_test_glob: "web/e2e/*.spec.ts"
  full: make test
`);

const neither = parseConfig(
	"app:\n  up: x\n  base_url: http://localhost:3456\ntests:\n  full: make test\n",
);

/** Records every command instead of running it. */
function fakeExec(result: Partial<ExecResult> = {}) {
	const calls: { cmd: string; opts?: ExecOptions }[] = [];

	const exec = async (cmd: string, opts?: ExecOptions) => {
		calls.push({ cmd, opts });
		return { code: 0, stdout: "", stderr: "", ...result };
	};

	return { exec, calls };
}

const SPEC = "frontend/tests/e2e/fixloop/size.spec.ts";

const NAME = "TestReproStorageSize";

const TEST = { file: SPEC, name: NAME };

const fail = (output: string) => ({ exitCode: 1, output });

/** What Playwright's list reporter prints around a failure, minus the error body. */
const header = (name: string) =>
	`Running 1 test using 1 worker\n\n  ✘  1 [chromium] › tests/e2e/fixloop/size.spec.ts:4:5 › ${name} (3.2s)\n\n\n  1) [chromium] › tests/e2e/fixloop/size.spec.ts:4:5 › ${name} ──────────\n\n`;

describe("classifyE2e", () => {
	it("is red on real Playwright 1.63 list output, even though it mentions a locator wait", () => {
		// Captured from the live run against Vikunja (paths shortened).
		const output = `Running 1 test using 1 worker

  ✘  1 [chromium] › tests/e2e/fixloop/attachment-size3.spec.ts:3:1 › TestReproAttachmentSize3 (6.0s)


  1) [chromium] › tests/e2e/fixloop/attachment-size3.spec.ts:3:1 › TestReproAttachmentSize3 ────────

    Error: expect(locator).toContainText(expected) failed

    Locator: locator('.attachments .files .attachment')
    Expected substring: "2 KB"
    Received string:    "two.txt 2.05 KB"
    Timeout: 5000ms

    Call log:
      - Expect "toContainText" locator('.attachments .files .attachment') with timeout 5000ms
      - waiting for locator('.attachments .files .attachment')
        14 × locator resolved to <div data-v-3863d125="" class="attachment">…</div>
           - unexpected value "two.txt 2.05 KB"

  1 failed`;

		const verdict = classifyE2e(fail(output), {
			file: "frontend/tests/e2e/fixloop/attachment-size3.spec.ts",
			name: "TestReproAttachmentSize3",
		});

		expect(verdict.red).toBe(true);
	});

	it("is red on a failed expect with Expected/Received", () => {
		const verdict = classifyE2e(
			fail(
				`${header(NAME)}    Error: expect(locator).toHaveText(expected) failed\n\n    Locator: getByTestId('attachment-size')\n    Expected: "2 KB"\n    Received: "2.05 KB"\n    Timeout: 5000ms\n\n  1 failed`,
			),
			TEST,
		);

		expect(verdict.red).toBe(true);
	});

	it("is red on a plain value assertion, with colour codes", () => {
		const verdict = classifyE2e(
			fail(
				`${header(NAME)}    \u001b[31mError: \u001b[39m\u001b[2mexpect(\u001b[22m\u001b[31mreceived\u001b[39m\u001b[2m).\u001b[22mtoBe\u001b[2m(\u001b[22m\u001b[32mexpected\u001b[39m\u001b[2m) // Object.is equality\u001b[22m\n\n    Expected: \u001b[32m"2 KB"\u001b[39m\n    Received: \u001b[31m"2.05 KB"\u001b[39m`,
			),
			TEST,
		);

		expect(verdict.red).toBe(true);
	});

	it("is red when toBeVisible fails", () => {
		const verdict = classifyE2e(
			fail(
				`${header(NAME)}    Error: expect(locator).toBeVisible() failed\n\n    Locator: getByTestId('x')\n    Expected: visible\n    Timeout: 5000ms\n    Error: element(s) not found`,
			),
			TEST,
		);

		expect(verdict.red).toBe(true);
	});

	it("is not red when the browser is not installed", () => {
		const verdict = classifyE2e(
			fail(
				`${header(NAME)}    Error: browserType.launch: Executable doesn't exist at /home/u/.cache/ms-playwright/chromium-1200/chrome\n║ Please run the following command to download new browsers: ║`,
			),
			TEST,
		);

		expect(verdict.red).toBe(false);
		expect(verdict.reason).toMatch(/browser is not installed/);
	});

	it("is not red when the page is not reachable", () => {
		const verdict = classifyE2e(
			fail(
				`${header(NAME)}    Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4173/login\n    Call log:\n      - navigating to "http://127.0.0.1:4173/login", waiting until "load"`,
			),
			TEST,
		);

		expect(verdict.red).toBe(false);
		expect(verdict.reason).toMatch(/not reachable/);
	});

	it("is not red when a locator was never found and nothing was asserted", () => {
		const verdict = classifyE2e(
			fail(
				`${header(NAME)}    Test timeout of 30000ms exceeded.\n\n    Error: locator.fill: Test timeout of 30000ms exceeded.\n    Call log:\n      - waiting for getByTestId('username')`,
			),
			TEST,
		);

		expect(verdict.red).toBe(false);
		expect(verdict.reason).toMatch(/timed out waiting/);
		expect(verdict.reason).toMatch(/broken test/);
	});

	it("is not red when a different test failed", () => {
		const verdict = classifyE2e(
			fail(
				`${header("TestSomethingElse")}    Error: expect(received).toBe(expected)\n\n    Expected: 1\n    Received: 2`,
			),
			TEST,
		);

		expect(verdict.red).toBe(false);
		expect(verdict.reason).toMatch(/does not name TestReproStorageSize/);
	});

	it("is not red when the test passed", () => {
		const verdict = classifyE2e(
			{ exitCode: 0, output: `  ✓  1 [chromium] › ${NAME}\n  1 passed` },
			TEST,
		);

		expect(verdict.red).toBe(false);
		expect(verdict.reason).toMatch(/passed/);
	});

	it.each([
		["SyntaxError: /x/size.spec.ts: Unexpected token (3:5)"],
		["Error: Cannot find module './nope'"],
		["ReferenceError: foo is not defined"],
		["TypeError: Cannot read properties of undefined (reading 'click')"],
		["Error: No tests found"],
	])("is not red for a broken spec: %s", (message) => {
		const verdict = classifyE2e(
			fail(`${header(NAME)}    ${message}`),
			TEST,
		);

		expect(verdict.red).toBe(false);
		expect(verdict.reason).not.toBe("");
	});

	it("does not let an assertion marker hide an unreachable page", () => {
		const verdict = classifyE2e(
			fail(
				`${header(NAME)}    Error: page.goto: net::ERR_CONNECTION_REFUSED at http://x\n    Expected: 1\n    Received: 2`,
			),
			TEST,
		);

		expect(verdict.red).toBe(false);
	});

	it("is not red when it failed without an assertion or a timeout", () => {
		expect(
			classifyE2e(fail(`${header(NAME)}    Error: boom`), TEST).red,
		).toBe(false);
	});
});

describe("frontendRunner with tests.e2e", () => {
	it("lists both globs, e2e only when configured", () => {
		expect(frontendRunner(both)?.testGlobs).toEqual([
			"frontend/src/**/*.test.ts",
			"frontend/tests/e2e/fixloop/*.spec.ts",
		]);
		expect(frontendRunner(vitestOnly)?.testGlobs).toEqual([
			"frontend/src/**/*.test.ts",
		]);
	});

	it("is valid with only tests.e2e, and undefined with neither", () => {
		expect(frontendRunner(e2eOnly)?.testGlobs).toEqual([
			"web/e2e/*.spec.ts",
		]);
		expect(frontendRunner(neither)).toBeUndefined();
	});

	it("names the env vars, never their values, in the hints", () => {
		const hints = frontendRunner(both)?.hints ?? "";

		expect(hints).toMatch(/Playwright/);
		expect(hints).toMatch(/process\.env\.BASE_URL/);
		expect(hints).toMatch(/process\.env\.FIXLOOP_TEST_USER/);
		expect(hints).toMatch(/process\.env\.FIXLOOP_TEST_PASSWORD/);
		expect(hints).toMatch(/frontend\/tests\/e2e\/fixloop\/\*\.spec\.ts/);
		expect(hints).toMatch(/TestRepro/);
		expect(hints).not.toMatch(/secret-pw/);
		// The Vitest hints stay when a frontend config is present.
		expect(hints).toMatch(/Vitest/);
	});

	it("keeps each hint set to the tools that are configured", () => {
		expect(frontendRunner(vitestOnly)?.hints).not.toMatch(/Playwright/);
		expect(frontendRunner(vitestOnly)?.hints).toMatch(
			/Prefer testing a pure helper/,
		);
		// Combined, only the e2e hints say when a unit test is right.
		expect(frontendRunner(both)?.hints).not.toMatch(
			/Prefer testing a pure helper/,
		);
		expect(frontendRunner(e2eOnly)?.hints).not.toMatch(/Vitest/);
	});

	it("runs a spec with the e2e command and a unit test with Vitest", async () => {
		const { exec, calls } = fakeExec();

		const runner = frontendRunner(both, exec);

		const ctx = { checkout: "/tmp/co", env: {} };

		await runner?.runTest(TEST, ctx);
		await runner?.runTest(
			{ file: "frontend/src/helpers/x.test.ts", name: "TestReproX" },
			ctx,
		);

		expect(calls.map((c) => c.cmd)).toEqual([
			"pnpm exec playwright test tests/e2e/fixloop/size.spec.ts -g TestReproStorageSize --reporter=list",
			"pnpm vitest run src/helpers/x.test.ts -t TestReproX",
		]);
		expect(calls.map((c) => c.opts?.cwd)).toEqual([
			"/tmp/co/frontend",
			"/tmp/co/frontend",
		]);
	});

	it("uses the e2e dir when only e2e is configured, and refuses a file no command covers", async () => {
		const { exec, calls } = fakeExec();

		const runner = frontendRunner(e2eOnly, exec);

		const ctx = { checkout: "/tmp/co", env: {} };

		await runner?.runTest(
			{ file: "web/e2e/a.spec.ts", name: "TestReproA" },
			ctx,
		);
		expect(calls[0]).toMatchObject({
			cmd: "pw e2e/a.spec.ts -g TestReproA",
			opts: { cwd: "/tmp/co/web" },
		});

		await expect(
			runner?.runTest({ file: "src/a.test.ts", name: "TestReproA" }, ctx),
		).rejects.toThrow(/no test command/);
		expect(calls).toHaveLength(1);
	});

	it("merges ctx.env over the config env and maps FIXLOOP_BASE_URL to BASE_URL, for e2e only", async () => {
		const { exec, calls } = fakeExec();

		const runner = frontendRunner(both, exec);

		const ctx = {
			checkout: "/tmp/co",
			env: {
				FIXLOOP_BASE_URL: "http://localhost:3456",
				FIXLOOP_TEST_USER: "override",
				PATH: "/bin",
			},
		};

		await runner?.runTest(TEST, ctx);
		await runner?.runTest(
			{ file: "frontend/src/helpers/x.test.ts", name: "TestReproX" },
			ctx,
		);

		expect(calls[0]?.opts?.env).toEqual({
			FIXLOOP_BASE_URL: "http://localhost:3456",
			BASE_URL: "http://localhost:3456",
			FIXLOOP_TEST_USER: "override",
			FIXLOOP_TEST_PASSWORD: "secret-pw",
			PATH: "/bin",
		});
		expect(calls[1]?.opts?.env).toEqual(ctx.env);
	});

	it("sets no BASE_URL when the app is not booted", async () => {
		const { exec, calls } = fakeExec();

		await frontendRunner(both, exec)?.runTest(TEST, {
			checkout: "/tmp/co",
			env: {},
		});

		expect(calls[0]?.opts?.env).toEqual({
			FIXLOOP_TEST_USER: "fixloop",
			FIXLOOP_TEST_PASSWORD: "secret-pw",
		});
	});

	it("rejects a shell-hostile name before running anything", async () => {
		const { exec, calls } = fakeExec();

		await expect(
			frontendRunner(both, exec)?.runTest(
				{ file: SPEC, name: "a; echo hi" },
				{ checkout: "/tmp/co", env: {} },
			),
		).rejects.toThrow(/unsafe test name/);
		expect(calls).toHaveLength(0);
	});

	it("classifies a spec by Playwright rules and a unit test by Vitest rules", () => {
		const runner = frontendRunner(both);

		const unitTest = { file: "frontend/src/x.test.ts", name: "TestReproX" };

		const playwrightRed = fail(
			`${header(NAME)}    Error: expect(locator).toHaveText(expected) failed\n    Expected: "2 KB"\n    Received: "2.05 KB"`,
		);

		const vitestRed = fail(
			" FAIL  src/x.test.ts > TestReproX\nAssertionError: expected '2.05 KB' to be '2 KB'",
		);

		expect(runner?.classify(playwrightRed, TEST).red).toBe(true);
		expect(runner?.classify(vitestRed, unitTest).red).toBe(true);

		// Only the e2e rules know that a net error is no shown bug.
		const withNetError = fail(
			"AssertionError: expected 1 to be 2\nnet::ERR_CONNECTION_REFUSED\nTestReproX TestReproStorageSize",
		);

		expect(runner?.classify(withNetError, TEST).red).toBe(false);
		expect(runner?.classify(withNetError, unitTest).red).toBe(true);
	});

	it("installs dependencies once per dir, then the browser, and reports a failed browser install", async () => {
		const root = await mkdtemp(join(tmpdir(), "fixloop-e2e-"));

		try {
			await mkdir(join(root, "frontend"), { recursive: true });

			const ok = fakeExec();

			await frontendRunner(both, ok.exec)?.prepare?.({
				checkout: root,
				env: { A: "1" },
			});
			expect(ok.calls.map((c) => c.cmd)).toEqual([
				"pnpm install --frozen-lockfile",
				"pnpm exec playwright install chromium",
			]);
			expect(ok.calls[1]?.opts).toMatchObject({
				cwd: join(root, "frontend"),
				env: { A: "1" },
				timeoutMs: 600_000,
			});

			await mkdir(join(root, "frontend", "node_modules"));

			const cached = fakeExec();

			await frontendRunner(both, cached.exec)?.prepare?.({
				checkout: root,
				env: {},
			});
			expect(cached.calls.map((c) => c.cmd)).toEqual([
				"pnpm exec playwright install chromium",
			]);

			const failing = fakeExec({ code: 1, stderr: "download failed" });

			await expect(
				frontendRunner(both, failing.exec)?.prepare?.({
					checkout: root,
					env: {},
				}),
			).rejects.toThrow(
				/playwright install chromium failed \(exit 1\): download failed/,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("installs the browser for an e2e-only config and nothing extra for Vitest only", async () => {
		const root = await mkdtemp(join(tmpdir(), "fixloop-e2e-"));

		try {
			await mkdir(join(root, "web", "node_modules"), { recursive: true });
			await mkdir(join(root, "frontend", "node_modules"), {
				recursive: true,
			});

			const e2e = fakeExec();

			await frontendRunner(e2eOnly, e2e.exec)?.prepare?.({
				checkout: root,
				env: {},
			});
			expect(e2e.calls).toMatchObject([
				{
					cmd: "pnpm exec playwright install chromium",
					opts: { cwd: join(root, "web") },
				},
			]);

			const unit = fakeExec();

			await frontendRunner(vitestOnly, unit.exec)?.prepare?.({
				checkout: root,
				env: {},
			});
			expect(unit.calls).toHaveLength(0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("frontendRunner needsApp", () => {
	it("is true only for Playwright specs, which drive the running app", () => {
		const runner = frontendRunner(both);

		expect(runner?.needsApp?.(SPEC)).toBe(true);
		expect(
			runner?.needsApp?.("frontend/src/helpers/getHumanSize.test.ts"),
		).toBe(false);
	});
});
