import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.js";
import { backendRunner } from "../src/repro/backend.js";

function configWith(run: string, dir = ".") {
	return parseConfig(
		`app:\n  up: "true"\n  base_url: http://localhost:1\ntests:\n  full: "true"\n  backend:\n    run: ${JSON.stringify(run)}\n    dir: ${dir}\n    new_test_glob: "pkg/**/*_test.go"\n`,
	);
}

const runner = backendRunner(configWith("go test ./{{dir}} -run ^{{name}}$"));

if (!runner) throw new Error("backend runner expected");

const classify = (exitCode: number, output: string) =>
	runner.classify({ exitCode, output });

const ASSERTION = `--- FAIL: TestReproNotIn (0.00s)
    zz_repro_test.go:12:
        	Error Trace:	/tmp/x/pkg/utils/zz_repro_test.go:12
        	Error:      	Not equal:
        	            	expected: []int64{3}
        	            	actual  : []int64(nil)
FAIL
FAIL	code.vikunja.io/api/pkg/utils	0.005s
`;

describe("backend classify", () => {
	it("is RED for a failed assertion", () => {
		expect(classify(1, ASSERTION).red).toBe(true);
	});

	it("is RED for a failed subtest, whose line is indented", () => {
		expect(
			classify(1, "    --- FAIL: TestRepro/case (0.00s)\nFAIL\n").red,
		).toBe(true);
	});

	it("is not RED for compile errors", () => {
		const undefinedName = `# code.vikunja.io/api/pkg/utils [code.vikunja.io/api/pkg/utils.test]
pkg/utils/zz_repro_test.go:9:12: undefined: NotInn
FAIL	code.vikunja.io/api/pkg/utils [build failed]
FAIL
`;

		const verdict = classify(1, undefinedName);

		expect(verdict.red).toBe(false);
		expect(verdict.reason).toContain("undefined: NotInn");

		for (const line of [
			"pkg/utils/x_test.go:5:2: declared and not used: got",
			'pkg/utils/x_test.go:3:8: "os" imported and not used',
			"pkg/utils/x_test.go:7:20: cannot use 1 (untyped int constant) as string value",
		]) {
			expect(
				classify(1, `# pkg\n${line}\nFAIL pkg [build failed]\n`).red,
			).toBe(false);
		}
	});

	it("is not RED when the package cannot be set up", () => {
		expect(
			classify(
				1,
				"# pkg/utils\npackage pkg/utils is not in std\nFAIL\tpkg/utils [setup failed]\nFAIL\n",
			).red,
		).toBe(false);
	});

	it("is not RED when there are no test files", () => {
		const verdict = classify(
			0,
			"?   \tcode.vikunja.io/api/pkg/x\t[no test files]\n",
		);

		expect(verdict.red).toBe(false);
		expect(verdict.reason).toMatch(/no test files/);
	});

	it("is not RED when the test passed", () => {
		const verdict = classify(
			0,
			"ok  \tcode.vikunja.io/api/pkg/utils\t0.004s\n",
		);

		expect(verdict.red).toBe(false);
		expect(verdict.reason).toMatch(/passed/);
	});

	it("is not RED when the name matched no test", () => {
		expect(
			classify(0, "ok  \tpkg/utils\t0.4s [no tests to run]\n").reason,
		).toMatch(/no test matched/);
	});

	it("is not RED when the command fails without a failed test", () => {
		expect(classify(1, "FAIL\tpkg/utils\t0.01s\n").red).toBe(false);
		expect(classify(124, "command timed out after 600000ms").red).toBe(
			false,
		);
	});

	const panic = (frames: string) => `--- FAIL: TestReproX (0.00s)
panic: runtime error: invalid memory address or nil pointer dereference [recovered]
	panic: runtime error: invalid memory address or nil pointer dereference
[signal SIGSEGV: segmentation violation code=0x1 addr=0x0 pc=0x1]

goroutine 7 [running]:
testing.tRunner.func1.2({0x1, 0x2})
	/opt/homebrew/Cellar/go/1.27.1/libexec/src/testing/testing.go:1734 +0x1ac
panic({0x1, 0x2})
	/opt/homebrew/Cellar/go/1.27.1/libexec/src/runtime/panic.go:787 +0x124
${frames}
FAIL	pkg/utils	0.01s
`;

	it("is not RED for a nil pointer panic in the test file itself", () => {
		const verdict = classify(
			1,
			panic(
				"pkg/utils.TestReproX(0x1)\n\t/tmp/x/pkg/utils/zz_repro_test.go:15 +0x20",
			),
		);

		expect(verdict.red).toBe(false);
		expect(verdict.reason).toMatch(/nil pointer/);
	});

	it("is RED for a nil pointer panic inside the code under test", () => {
		expect(
			classify(
				1,
				panic(
					"pkg/utils.NotIn(...)\n\t/tmp/x/pkg/utils/slice_difference.go:20 +0x20\npkg/utils.TestReproX(0x1)\n\t/tmp/x/pkg/utils/zz_repro_test.go:15 +0x20",
				),
			).red,
		).toBe(true);
	});
});

describe("backend runTest", () => {
	let checkout: string;

	beforeEach(async () => {
		checkout = await mkdtemp(join(tmpdir(), "fixloop-backend-"));
		await mkdir(join(checkout, "sub"), { recursive: true });
	});

	afterEach(() => rm(checkout, { recursive: true, force: true }));

	// `echo` stands in for `go test`, so the substituted command is visible in the output.
	const echoRunner = (dir = ".") => {
		const r = backendRunner(
			configWith("echo {{dir}} {{file}} {{name}}", dir),
		);

		if (!r) throw new Error("backend runner expected");

		return r;
	};

	it("derives the directory from the file and runs in the configured dir", async () => {
		const result = await echoRunner("sub").runTest(
			{ file: "pkg/utils/zz_repro_test.go", name: "TestReproX" },
			{ checkout, env: {} },
		);

		expect(result).toEqual({
			exitCode: 0,
			output: "pkg/utils pkg/utils/zz_repro_test.go TestReproX\n",
		});
	});

	it("uses the dot directory for a file at the repo root", async () => {
		const result = await echoRunner().runTest(
			{ file: "./a_test.go", name: "TestReproX" },
			{ checkout, env: {} },
		);

		expect(result.output).toBe(". a_test.go TestReproX\n");
	});

	it("passes the context env and returns stderr in the output", async () => {
		await writeFile(
			join(checkout, "t.sh"),
			"echo $FIXLOOP_X >&2; exit 3\n",
		);

		const r = backendRunner(configWith("sh t.sh"));

		expect(
			await r?.runTest(
				{ file: "a_test.go", name: "TestReproX" },
				{ checkout, env: { FIXLOOP_X: "seen" } },
			),
		).toEqual({ exitCode: 3, output: "seen\n" });
	});

	it("rejects shell-hostile names and escaping paths before running anything", async () => {
		const ctx = { checkout, env: {} };

		await expect(
			echoRunner().runTest(
				{ file: "a_test.go", name: "T; rm -rf /" },
				ctx,
			),
		).rejects.toThrow(/unsafe/);
		await expect(
			echoRunner().runTest({ file: "../a_test.go", name: "TestX" }, ctx),
		).rejects.toThrow(/unsafe/);
	});

	it("fails loudly on an unknown placeholder", async () => {
		const r = backendRunner(configWith("go test {{pkg}}"));

		await expect(
			r?.runTest(
				{ file: "a_test.go", name: "TestX" },
				{ checkout, env: {} },
			),
		).rejects.toThrow(/unknown placeholder/);
	});
});

describe("backendRunner", () => {
	it("is undefined without tests.backend", () => {
		expect(
			backendRunner(
				parseConfig(
					'app:\n  up: "true"\n  base_url: http://localhost:1\ntests:\n  full: "true"\n  frontend:\n    run: x\n    new_test_glob: y\n',
				),
			),
		).toBeUndefined();
	});

	it("exposes the area, glob and Go hints", () => {
		expect(runner.area).toBe("backend");
		expect(runner.testGlob).toBe("pkg/**/*_test.go");
		expect(runner.hints).toContain("TestRepro");
	});
});
