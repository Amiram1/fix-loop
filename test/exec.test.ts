import { describe, expect, it } from "vitest";
import { run } from "../src/boot/exec.js";

describe("run", () => {
	it("captures stdout, stderr and the exit code", async () => {
		const r = await run("echo out; echo err 1>&2; exit 3");

		expect(r).toEqual({ code: 3, stdout: "out\n", stderr: "err\n" });
	});

	it("runs in cwd and merges env over the parent environment", async () => {
		const r = await run('pwd; echo "$FIXLOOP_TEST_VAR"', {
			cwd: "/tmp",
			env: { FIXLOOP_TEST_VAR: "hello" },
		});

		expect(r.code).toBe(0);
		expect(r.stdout).toMatch(/tmp\nhello\n$/);
	});

	it("kills the command on timeout and reports code 124", async () => {
		const started = Date.now();

		const r = await run("sleep 30", { timeoutMs: 100 });

		expect(r.code).toBe(124);
		expect(r.stderr).toContain("timed out after 100ms");
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	it("returns a non-zero code instead of rejecting for a missing command", async () => {
		const r = await run("definitely-not-a-command-xyz");

		expect(r.code).not.toBe(0);
		expect(r.stderr).not.toBe("");
	});
});

describe("command environment", () => {
	it("keeps FixLoop's secrets away from commands, and keeps the variables a toolchain needs", async () => {
		const saved = {
			key: process.env.ANTHROPIC_API_KEY,
			token: process.env.GITHUB_TOKEN,
		};

		process.env.ANTHROPIC_API_KEY = "sk-test-secret";
		process.env.GITHUB_TOKEN = "ghs_test_secret";

		try {
			const probe =
				"node -e \"console.log(String(process.env.ANTHROPIC_API_KEY) + ' ' + String(process.env.GITHUB_TOKEN) + ' ' + (process.env.PATH ? 'path' : 'nopath'))\"";

			const r = await run(probe);

			expect(r.stdout.trim()).toBe("undefined undefined path");
		} finally {
			if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = saved.key;

			if (saved.token === undefined) delete process.env.GITHUB_TOKEN;
			else process.env.GITHUB_TOKEN = saved.token;
		}
	});

	it("passes config-provided variables through", async () => {
		const r = await run(
			'node -e "console.log(process.env.FIXLOOP_TEST_USER)"',
			{
				env: { FIXLOOP_TEST_USER: "fixloop" },
			},
		);

		expect(r.stdout.trim()).toBe("fixloop");
	});
});
