// The contract every area runner implements. The loop and the stage know nothing about Go or Vitest.

/** One run of one test, as the runner saw it. */
export interface TestRun {
	exitCode: number;
	/** Combined stdout and stderr. Only the tail is shown to the model. */
	output: string;
}

export interface RunContext {
	/** Scratch checkout that holds the code under test and the new test file. */
	checkout: string;
	/** Extra environment for the test command, e.g. FIXLOOP_BASE_URL when the app is booted. */
	env: Record<string, string>;
}

export interface Classification {
	/** True only when the test failed because the reported bug is present. */
	red: boolean;
	/** One line the model and the status comment can read. */
	reason: string;
}

export interface AreaRunner {
	area: "backend" | "frontend";
	/** Glob for files the agent may create, from config tests.<area>.new_test_glob. */
	testGlob: string;
	/** Stack-specific guidance for the model: how tests are written, named and run here. */
	hints: string;
	/** One-time setup in the scratch checkout, such as installing dependencies. */
	prepare?: (ctx: RunContext) => Promise<void>;
	/** Runs one test. `file` and `name` have already passed the loop's validation. */
	runTest: (
		test: { file: string; name: string },
		ctx: RunContext,
	) => Promise<TestRun>;
	/** Decides whether a failing run failed on the bug, not on a build error or a broken test. */
	classify: (run: TestRun) => Classification;
}

const NAME_PATTERN = /^[A-Za-z0-9_./-]{1,200}$/;

/** Test names and paths go into shell commands, so only a conservative character set is allowed. */
export function isSafeName(value: string): boolean {
	return NAME_PATTERN.test(value);
}

/** Returns the normalised repo-relative path, or undefined if it could escape the checkout. */
export function safeRelativePath(value: string): string | undefined {
	if (!isSafeName(value)) return undefined;

	if (value.startsWith("/") || value.split("/").includes(".."))
		return undefined;

	return value.replace(/^\.\//, "");
}

/** Replaces {{key}} placeholders. Values must already be validated by the caller. */
export function substitute(
	template: string,
	vars: Record<string, string>,
): string {
	return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
		const value = vars[key];

		if (value === undefined)
			throw new Error(`unknown placeholder ${match} in test command`);

		return value;
	});
}

/** Keeps the end of a long output, where the failure usually is. */
export function tail(text: string, maxChars = 4000): string {
	return text.length > maxChars ? `...${text.slice(-maxChars)}` : text;
}
