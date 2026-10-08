import { describe, expect, it } from "vitest";
import {
	isSafeName,
	safeRelativePath,
	substitute,
	tail,
} from "../src/repro/runner.js";

describe("runner helpers", () => {
	it("accepts simple test names and rejects shell metacharacters", () => {
		expect(isSafeName("TestNotIn_FirstElement")).toBe(true);
		expect(isSafeName("pkg/utils/x.test")).toBe(true);
		expect(isSafeName("a;b")).toBe(false);
		expect(isSafeName("$(whoami)")).toBe(false);
		expect(isSafeName("")).toBe(false);
	});

	it("keeps repo-relative paths and refuses escapes", () => {
		expect(safeRelativePath("./pkg/a_test.go")).toBe("pkg/a_test.go");
		expect(safeRelativePath("/etc/passwd")).toBeUndefined();
		expect(safeRelativePath("pkg/../../x")).toBeUndefined();
	});

	it("substitutes known placeholders and fails loudly on unknown ones", () => {
		expect(
			substitute("go test {{pkgdir}} -run {{name}}", {
				pkgdir: "./pkg/utils",
				name: "TestX",
			}),
		).toBe("go test ./pkg/utils -run TestX");
		expect(() => substitute("{{nope}}", {})).toThrow(/unknown placeholder/);
	});

	it("keeps the end of long output", () => {
		expect(tail("abcdef", 3)).toBe("...def");
		expect(tail("ab", 3)).toBe("ab");
	});
});
