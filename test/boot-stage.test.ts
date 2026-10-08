import { describe, expect, it, vi } from "vitest";
import type { Exec } from "../src/boot/exec.js";
import { ConfigSchema } from "../src/config/schema.js";
import type { BootedApp } from "../src/pipeline/artifacts.js";
import { makeBootStage, withBootedApp } from "../src/pipeline/boot.js";
import type { RunContext } from "../src/pipeline/run.js";

const config = ConfigSchema.parse({
	app: {
		up: "make up",
		down: "make down",
		base_url: "http://localhost:3456",
	},
	tests: { full: "make test" },
});

// A frontend report: the only kind that needs the running app.
const ctx = (): RunContext => ({
	runId: "t",
	config,
	issue: { number: 1, title: "t", body: "", labels: [] },
	dryRun: true,
	artifacts: {
		intake: {
			area: "frontend",
			severity: "S3",
			summary: "s",
			injectionSuspected: false,
		},
	},
});

const fakeApp = (stop: () => Promise<void>): BootedApp => ({
	baseUrl: "http://x",
	collectLogs: async () => "",
	stop,
});

describe("makeBootStage", () => {
	it("is named Boot, boots the app and publishes it on the context", async () => {
		const cmds: string[] = [];

		const exec: Exec = async (cmd) => {
			cmds.push(cmd);
			return { code: 0, stdout: "", stderr: "" };
		};

		const stage = makeBootStage({
			exec,
			cwd: "/work",
			fetch: (async () =>
				new Response(null, { status: 200 })) as typeof fetch,
		});

		const c = ctx();

		const outcome = await stage.run(c);

		expect(stage.name).toBe("Boot");
		expect(outcome).toEqual({
			state: "done",
			detail: "http://localhost:3456",
		});
		expect(c.artifacts.app?.baseUrl).toBe("http://localhost:3456");
		expect(cmds).toEqual(["make up"]);

		await c.artifacts.app?.stop();

		expect(cmds).toEqual(["make up", "make down"]);
	});

	it("leaves artifacts.app unset when boot fails", async () => {
		const exec: Exec = async (cmd) => ({
			code: cmd === "make up" ? 1 : 0,
			stdout: "",
			stderr: "bad",
		});

		const c = ctx();

		await expect(makeBootStage({ exec }).run(c)).rejects.toThrow(
			/app\.up failed/,
		);
		expect(c.artifacts.app).toBeUndefined();
	});
});

describe("withBootedApp", () => {
	it("stops the app after the work succeeds and returns its result", async () => {
		let stops = 0;

		const c = ctx();

		const result = await withBootedApp(c, async () => {
			c.artifacts.app = fakeApp(async () => void stops++);
			return 42;
		});

		expect(result).toBe(42);
		expect(stops).toBe(1);
	});

	it("stops the app and rethrows when the work throws", async () => {
		let stops = 0;

		const c = ctx();

		await expect(
			withBootedApp(c, async () => {
				c.artifacts.app = fakeApp(async () => void stops++);
				throw new Error("stage blew up");
			}),
		).rejects.toThrow("stage blew up");
		expect(stops).toBe(1);
	});

	it("keeps the original error when stop also fails", async () => {
		const c = ctx();

		await expect(
			withBootedApp(c, async () => {
				c.artifacts.app = fakeApp(async () => {
					throw new Error("down failed");
				});
				throw new Error("stage blew up");
			}),
		).rejects.toThrow("stage blew up");
	});

	it("surfaces a stop failure when the work itself succeeded", async () => {
		const c = ctx();

		await expect(
			withBootedApp(c, async () => {
				c.artifacts.app = fakeApp(async () => {
					throw new Error("down failed");
				});
			}),
		).rejects.toThrow("down failed");
	});

	it("does nothing extra when no app was booted", async () => {
		await expect(withBootedApp(ctx(), async () => "ok")).resolves.toBe(
			"ok",
		);
	});

	it("does not boot the app for a backend report, which never drives it", async () => {
		const exec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));

		const ctx = {
			runId: "t",
			config,
			issue: { number: 1, title: "t", body: "", labels: [] },
			dryRun: true,
			artifacts: {
				intake: {
					area: "backend",
					severity: "S2",
					summary: "s",
					injectionSuspected: false,
				},
			},
		} as unknown as RunContext;

		const outcome = await makeBootStage({ exec }).run(ctx);

		expect(outcome.state).toBe("skipped");
		expect(exec).not.toHaveBeenCalled();
		expect(ctx.artifacts.app).toBeUndefined();
	});
});
