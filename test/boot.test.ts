import { appendFile, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BootDeps, bootApp } from "../src/boot/boot.js";
import type { Exec, ExecOptions, ExecResult } from "../src/boot/exec.js";
import { ConfigSchema, type FixLoopConfig } from "../src/config/schema.js";

const T0 = Date.parse("2026-10-08T09:00:00.000Z");

function makeConfig(
	app: Record<string, unknown> = {},
	logs: unknown[] = [],
): FixLoopConfig {
	return ConfigSchema.parse({
		app: {
			up: "make up",
			down: "make down",
			base_url: "http://localhost:3456",
			...app,
		},
		logs,
		tests: { full: "make test" },
	});
}

interface Harness {
	deps: Required<BootDeps>;
	/** Everything that happened, in order: shell commands and "fetch" probes. */
	events: string[];
	calls: { cmd: string; opts?: ExecOptions }[];
	cmds: () => string[];
}

/**
 * Fake exec/fetch/clock. `reply` decides the result of each command (default: success);
 * `statuses` is consumed one per health probe, where a number is an HTTP status and
 * "refused" is a connection error. The last entry repeats.
 */
function harness(
	opts: {
		reply?: (cmd: string) => Partial<ExecResult> | undefined;
		statuses?: (number | "refused")[];
	} = {},
): Harness {
	const events: string[] = [];

	const calls: Harness["calls"] = [];

	const statuses = [...(opts.statuses ?? [200])];

	let clock = T0;

	const exec: Exec = async (cmd, o) => {
		events.push(cmd);
		calls.push({ cmd, opts: o });
		return { code: 0, stdout: "", stderr: "", ...opts.reply?.(cmd) };
	};

	const fetchFake = async () => {
		events.push("fetch");

		const next = statuses.length > 1 ? statuses.shift() : statuses[0];

		if (next === "refused") {
			throw Object.assign(new TypeError("fetch failed"), {
				cause: { code: "ECONNREFUSED" },
			});
		}

		return new Response(null, { status: next });
	};

	return {
		deps: {
			exec,
			fetch: fetchFake as unknown as typeof fetch,
			now: () => clock,
			sleep: async (ms) => {
				clock += ms;
			},
		},
		events,
		calls,
		cmds: () => calls.map((c) => c.cmd),
	};
}

describe("bootApp lifecycle", () => {
	it("runs up, health check, seed, then down on stop", async () => {
		const h = harness({ statuses: ["refused", 503, 200] });

		const app = await bootApp({
			...h.deps,
			config: makeConfig({ seed: "./seed.sh" }),
			cwd: "/work",
		});

		expect(h.events).toEqual([
			"make up",
			"fetch",
			"fetch",
			"fetch",
			"./seed.sh",
		]);
		expect(app.baseUrl).toBe("http://localhost:3456");

		await app.stop();

		expect(h.events.at(-1)).toBe("make down");
	});

	it("treats any status below 500 as healthy", async () => {
		const h = harness({ statuses: [404] });

		await bootApp({ ...h.deps, config: makeConfig(), cwd: "/work" });

		expect(h.events).toEqual(["make up", "fetch"]);
	});

	it("runs commands in cwd with the base URL in the environment", async () => {
		const h = harness();

		const app = await bootApp({
			...h.deps,
			config: makeConfig({ seed: "./seed.sh" }),
			cwd: "/work",
		});

		await app.stop();

		expect(h.calls.map((c) => c.opts?.cwd)).toEqual([
			"/work",
			"/work",
			"/work",
		]);
		expect(h.calls.map((c) => c.opts?.env)).toEqual(
			Array(3).fill({ FIXLOOP_BASE_URL: "http://localhost:3456" }),
		);
	});

	it("runs down only once however often stop is called", async () => {
		const h = harness();

		const app = await bootApp({
			...h.deps,
			config: makeConfig(),
			cwd: "/work",
		});

		await Promise.all([app.stop(), app.stop()]);
		await app.stop();

		expect(h.cmds().filter((c) => c === "make down")).toHaveLength(1);
	});

	it("stop rejects with the stderr tail when down fails, and does not retry", async () => {
		const h = harness({
			reply: (cmd) =>
				cmd === "make down"
					? { code: 2, stderr: "network busy" }
					: undefined,
		});

		const app = await bootApp({
			...h.deps,
			config: makeConfig(),
			cwd: "/work",
		});

		await expect(app.stop()).rejects.toThrow(
			/app\.down failed \(exit 2\):\nnetwork busy/,
		);
		await expect(app.stop()).rejects.toThrow(/app\.down failed/);
		expect(h.cmds().filter((c) => c === "make down")).toHaveLength(1);
	});

	it("stop is a no-op when no down command is configured", async () => {
		const h = harness();

		const app = await bootApp({
			...h.deps,
			config: makeConfig({ down: undefined }),
			cwd: "/work",
		});

		await app.stop();

		expect(h.cmds()).toEqual(["make up"]);
	});
});

describe("bootApp failures", () => {
	it("tears down and throws the stderr tail when up fails", async () => {
		const stderr = Array.from({ length: 30 }, (_, i) => `line ${i}`).join(
			"\n",
		);

		const h = harness({
			reply: (cmd) =>
				cmd === "make up" ? { code: 1, stderr } : undefined,
		});

		const err = await bootApp({
			...h.deps,
			config: makeConfig(),
			cwd: "/work",
		}).catch((e: Error) => e);

		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toMatch(/^app\.up failed \(exit 1\):/);
		expect((err as Error).message).toContain("line 29");
		expect((err as Error).message).not.toContain("line 0\n");
		expect(h.events).toEqual(["make up", "make down"]);
	});

	it("falls back to stdout when up fails with no stderr", async () => {
		const h = harness({
			reply: (cmd) =>
				cmd === "make up"
					? { code: 1, stdout: "boom on stdout" }
					: undefined,
		});

		await expect(
			bootApp({ ...h.deps, config: makeConfig(), cwd: "/work" }),
		).rejects.toThrow(/boom on stdout/);
	});

	it("still throws the up error when the best-effort down fails too", async () => {
		const h = harness({
			reply: (cmd) =>
				cmd === "make up"
					? { code: 1, stderr: "up broke" }
					: { code: 9, stderr: "down broke" },
		});

		await expect(
			bootApp({ ...h.deps, config: makeConfig(), cwd: "/work" }),
		).rejects.toThrow(/app\.up failed.*up broke/s);
	});

	it("tears down and throws when the app never becomes healthy", async () => {
		const h = harness({ statuses: [503] });

		await expect(
			bootApp({
				...h.deps,
				config: makeConfig({ health_timeout_s: 5, seed: "./seed.sh" }),
				cwd: "/work",
			}),
		).rejects.toThrow(/within 5s \(last: HTTP 503\)/);

		const probes = h.events.filter((e) => e === "fetch").length;

		expect(h.cmds()).toEqual(["make up", "make down"]);
		// one probe per fake second until the 5s deadline
		expect(probes).toBeGreaterThanOrEqual(5);
		expect(probes).toBeLessThanOrEqual(7);
	});

	it("reports the connection error when nothing ever listens", async () => {
		const h = harness({ statuses: ["refused"] });

		await expect(
			bootApp({
				...h.deps,
				config: makeConfig({ health_timeout_s: 2 }),
				cwd: "/work",
			}),
		).rejects.toThrow(/last: ECONNREFUSED/);
	});

	it("tears down and throws when seed fails", async () => {
		const h = harness({
			reply: (cmd) =>
				cmd === "./seed.sh" ? { code: 3, stderr: "no db" } : undefined,
		});

		await expect(
			bootApp({
				...h.deps,
				config: makeConfig({ seed: "./seed.sh" }),
				cwd: "/work",
			}),
		).rejects.toThrow(/app\.seed failed \(exit 3\):\nno db/);

		expect(h.cmds()).toEqual(["make up", "./seed.sh", "make down"]);
	});
});

describe("bootApp docker log collection", () => {
	it("runs docker compose logs since boot for the listed services", async () => {
		const h = harness({
			reply: (cmd) =>
				cmd.includes(" logs ")
					? { stdout: "api-1  | listening\n" }
					: undefined,
		});

		const app = await bootApp({
			...h.deps,
			config: makeConfig({}, [
				{
					type: "docker",
					services: ["api", "web"],
					compose_file: "docker-compose.fixloop.yml",
				},
			]),
			cwd: "/work",
		});

		const logs = await app.collectLogs();

		expect(h.cmds().at(-1)).toBe(
			"docker compose -f docker-compose.fixloop.yml logs --no-color --since 2026-10-08T09:00:00.000Z api web",
		);
		expect(logs).toContain("docker logs: api, web");
		expect(logs).toContain("api-1  | listening");
	});

	it("omits -f without compose_file and quotes odd names", async () => {
		const h = harness();

		const app = await bootApp({
			...h.deps,
			config: makeConfig({}, [
				{ type: "docker", services: ["my svc", "it's"] },
			]),
			cwd: "/work",
		});

		await app.collectLogs();

		expect(h.cmds().at(-1)).toBe(
			`docker compose logs --no-color --since 2026-10-08T09:00:00.000Z 'my svc' 'it'\\''s'`,
		);
	});

	it("reports a failed log command in the text instead of throwing", async () => {
		const h = harness({
			reply: (cmd) =>
				cmd.includes(" logs ")
					? { code: 1, stderr: "no such service: api" }
					: undefined,
		});

		const app = await bootApp({
			...h.deps,
			config: makeConfig({}, [{ type: "docker", services: ["api"] }]),
			cwd: "/work",
		});

		await expect(app.collectLogs()).resolves.toContain(
			"could not collect: docker compose logs failed (exit 1):\nno such service: api",
		);
	});

	it("returns an empty string when no log sources are configured", async () => {
		const h = harness();

		const app = await bootApp({
			...h.deps,
			config: makeConfig(),
			cwd: "/work",
		});

		await expect(app.collectLogs()).resolves.toBe("");
	});
});

describe("bootApp file log collection", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "fixloop-boot-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	const boot = (logs: unknown[]) => {
		const h = harness();

		return bootApp({
			...h.deps,
			config: makeConfig({}, logs),
			cwd: dir,
		});
	};

	it("reads only what was appended since boot", async () => {
		const file = join(dir, "app.log");

		await writeFile(file, "before boot\n");

		const app = await boot([{ type: "file", path: "app.log" }]);

		await appendFile(file, "after boot\n");

		const logs = await app.collectLogs();

		expect(logs).toContain("appended since boot, bytes 12-23");
		expect(logs).toContain("after boot");
		expect(logs).not.toContain("before boot");
	});

	it("reads the whole file when it was created since boot, across a glob", async () => {
		await writeFile(join(dir, "a.log"), "old a\n");

		const app = await boot([{ type: "file", path: join(dir, "*.log") }]);

		await writeFile(join(dir, "b.log"), "fresh b\n");
		await appendFile(join(dir, "a.log"), "new a\n");

		const logs = await app.collectLogs();

		expect(logs).toContain("a.log (appended since boot, bytes 6-12)");
		expect(logs).toContain("b.log (whole file, created since boot)");
		expect(logs).toContain("fresh b");
		expect(logs).toContain("new a");
		expect(logs).not.toContain("old a");
	});

	it("reads the whole file when it shrank since boot", async () => {
		const file = join(dir, "app.log");

		await writeFile(file, "a long line from before\n");

		const app = await boot([{ type: "file", path: "app.log" }]);

		await truncate(file, 0);
		await appendFile(file, "rotated\n");

		const logs = await app.collectLogs();

		expect(logs).toContain("whole file, shrank since boot");
		expect(logs).toContain("rotated");
	});

	it("says so when no file matches", async () => {
		const app = await boot([{ type: "file", path: "missing/*.log" }]);

		await expect(app.collectLogs()).resolves.toContain(
			"(no files matched)",
		);
	});
});
