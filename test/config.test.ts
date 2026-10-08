import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config/load.js";

const minimal = `
app:
  up: docker compose up -d
  base_url: http://localhost:3456
tests:
  full: make test
`;

describe("parseConfig", () => {
	it("accepts a minimal config and fills defaults", () => {
		const cfg = parseConfig(minimal);

		expect(cfg.app.health_timeout_s).toBe(120);
		expect(cfg.budget.max_fix_iterations).toBe(4);
		expect(cfg.models.triage).toBe("claude-haiku-5-5");
		expect(cfg.risk.max_diff_lines).toBe(150);
	});

	it("reports the failing path", () => {
		const bad = minimal.replace(
			"base_url: http://localhost:3456",
			"base_url: not-a-url",
		);

		expect(() => parseConfig(bad)).toThrow(ConfigError);
		expect(() => parseConfig(bad)).toThrow(/app\.base_url/);
	});

	it("rejects missing required test command", () => {
		expect(() =>
			parseConfig("app:\n  up: x\n  base_url: http://a.b\n"),
		).toThrow(/tests/);
	});

	it("rejects invalid YAML", () => {
		expect(() => parseConfig("app: [")).toThrow(/not valid YAML/);
	});

	it("validates log source discriminants", () => {
		const withLogs = `${minimal}logs:\n  - { type: docker, services: [] }\n`;

		expect(() => parseConfig(withLogs)).toThrow(/logs/);
	});

	it("accepts compose_file on docker log sources", () => {
		const cfg = parseConfig(
			`${minimal}logs:\n  - { type: docker, services: [api], compose_file: docker-compose.fixloop.yml }\n`,
		);

		expect(cfg.logs).toEqual([
			{
				type: "docker",
				services: ["api"],
				compose_file: "docker-compose.fixloop.yml",
			},
		]);
	});

	it("keeps compose_file optional and rejects an empty one", () => {
		const bare = parseConfig(
			`${minimal}logs:\n  - { type: docker, services: [api] }\n`,
		);

		expect(bare.logs[0]).not.toHaveProperty("compose_file");
		expect(() =>
			parseConfig(
				`${minimal}logs:\n  - { type: docker, services: [api], compose_file: "" }\n`,
			),
		).toThrow(/compose_file/);
	});

	it("defaults tests.e2e.env to empty and accepts string values", () => {
		const e2e = minimal.replace(
			"tests:\n",
			"tests:\n  e2e:\n    run: pw {{file}}\n    new_test_glob: 'e2e/*.spec.ts'\n",
		);

		expect(parseConfig(e2e).tests.e2e?.env).toEqual({});

		const withEnv = e2e.replace(
			"new_test_glob: 'e2e/*.spec.ts'\n",
			"new_test_glob: 'e2e/*.spec.ts'\n    env: { FIXLOOP_TEST_USER: fixloop }\n",
		);

		expect(parseConfig(withEnv).tests.e2e?.env).toEqual({
			FIXLOOP_TEST_USER: "fixloop",
		});
		expect(() =>
			parseConfig(withEnv.replace("fixloop }", "[1] }")),
		).toThrow(/env/);
	});
});
