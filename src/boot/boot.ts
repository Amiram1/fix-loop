import { glob, open, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { FixLoopConfig } from "../config/schema.js";
import type { BootedApp } from "../pipeline/artifacts.js";
import { type Exec, type ExecResult, run } from "./exec.js";

type LogSource = FixLoopConfig["logs"][number];

export interface BootDeps {
	exec?: Exec;
	fetch?: typeof fetch;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

export interface BootOptions extends BootDeps {
	config: FixLoopConfig;
	/** Directory the target repo is checked out in. Config commands run here. */
	cwd: string;
}

// `up` may include a docker build, so it gets far longer than the health check.
const UP_TIMEOUT_MS = 20 * 60_000;

const SEED_TIMEOUT_MS = 2 * 60_000;

const DOWN_TIMEOUT_MS = 2 * 60_000;

const LOGS_TIMEOUT_MS = 30_000;

const PROBE_TIMEOUT_MS = 5_000;

const POLL_INTERVAL_MS = 1_000;

/** Cap per log source so a chatty app cannot blow up an agent prompt. The tail is kept. */
const MAX_LOG_CHARS = 200_000;

const defaultSleep = (ms: number) =>
	new Promise<void>((done) => setTimeout(done, ms));

function tail(text: string, lines = 20, maxChars = 2_000): string {
	return text.trim().split("\n").slice(-lines).join("\n").slice(-maxChars);
}

function failure(what: string, r: ExecResult): Error {
	const out = tail(r.stderr.trim() ? r.stderr : r.stdout);

	return new Error(
		`${what} failed (exit ${r.code})${out ? `:\n${out}` : ""}`,
	);
}

function shellQuote(arg: string): string {
	return /^[\w@%+=:,./-]+$/.test(arg)
		? arg
		: `'${arg.replaceAll("'", `'\\''`)}'`;
}

function describeFetchError(err: unknown): string {
	const e = err as Error & { cause?: { code?: string } };

	return e.cause?.code ?? e.message;
}

/** Files matching a literal path or glob (relative to cwd), regular files only, with sizes. */
async function listFiles(
	pattern: string,
	cwd: string,
): Promise<Map<string, number>> {
	const files = new Map<string, number>();

	try {
		for await (const match of glob(pattern, { cwd })) {
			const path = resolve(cwd, match);

			const info = await stat(path).catch(() => undefined);

			if (info?.isFile()) files.set(path, info.size);
		}
	} catch {
		// unreadable directory: treat as no match
	}
	return files;
}

async function readRange(
	path: string,
	start: number,
	end: number,
): Promise<string> {
	const handle = await open(path, "r");

	try {
		const buf = Buffer.alloc(end - start);

		const { bytesRead } = await handle.read(buf, 0, buf.length, start);

		return buf.toString("utf8", 0, bytesRead);
	} finally {
		await handle.close();
	}
}

/**
 * Runs `app.up`, waits until `base_url` answers below HTTP 500, then runs `app.seed`.
 * If any step fails, `app.down` is run (best effort) and the error is thrown, so a failed
 * boot never leaves containers behind.
 */
export async function bootApp(opts: BootOptions): Promise<BootedApp> {
	const { config, cwd } = opts;

	const { app } = config;

	const exec = opts.exec ?? run;

	const doFetch = opts.fetch ?? fetch;

	const now = opts.now ?? Date.now;

	const sleep = opts.sleep ?? defaultSleep;

	// Config commands (seed scripts in particular) can read the URL from here.
	const env = { FIXLOOP_BASE_URL: app.base_url };

	// Taken before `up` so the boot's own output is part of "since boot".
	const bootedAt = new Date(now()).toISOString();

	const fileSizesAtBoot = new Map<string, number>();

	for (const src of config.logs) {
		if (src.type !== "file") continue;

		for (const [path, size] of await listFiles(src.path, cwd)) {
			fileSizesAtBoot.set(path, size);
		}
	}

	const down = app.down;

	let stopping: Promise<void> | undefined;

	const stop = (): Promise<void> => {
		stopping ??= (async () => {
			if (!down) return;

			const r = await exec(down, {
				cwd,
				env,
				timeoutMs: DOWN_TIMEOUT_MS,
			});

			if (r.code !== 0) throw failure("app.down", r);
		})();
		return stopping;
	};

	const probe = async (): Promise<{ ok: boolean; note: string }> => {
		try {
			const res = await doFetch(app.base_url, {
				redirect: "manual",
				signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
			});

			await res.body?.cancel().catch(() => undefined);
			return { ok: res.status < 500, note: `HTTP ${res.status}` };
		} catch (err) {
			return { ok: false, note: describeFetchError(err) };
		}
	};

	const waitHealthy = async () => {
		const deadline = now() + app.health_timeout_s * 1000;

		for (;;) {
			const { ok, note } = await probe();

			if (ok) return;

			if (now() >= deadline) {
				throw new Error(
					`${app.base_url} did not answer below HTTP 500 within ${app.health_timeout_s}s (last: ${note})`,
				);
			}

			await sleep(Math.min(POLL_INTERVAL_MS, deadline - now()));
		}
	};

	try {
		const upResult = await exec(app.up, {
			cwd,
			env,
			timeoutMs: UP_TIMEOUT_MS,
		});

		if (upResult.code !== 0) throw failure("app.up", upResult);

		await waitHealthy();

		if (app.seed) {
			const seeded = await exec(app.seed, {
				cwd,
				env,
				timeoutMs: SEED_TIMEOUT_MS,
			});

			if (seeded.code !== 0) throw failure("app.seed", seeded);
		}
	} catch (err) {
		await stop().catch(() => undefined);
		throw err;
	}

	const dockerLogs = async (
		src: Extract<LogSource, { type: "docker" }>,
	): Promise<string> => {
		const composeFile = src.compose_file
			? ` -f ${shellQuote(src.compose_file)}`
			: "";

		const services = src.services.map(shellQuote).join(" ");

		const r = await exec(
			`docker compose${composeFile} logs --no-color --since ${bootedAt} ${services}`,
			{ cwd, env, timeoutMs: LOGS_TIMEOUT_MS },
		);

		const header = `=== docker logs: ${src.services.join(", ")} (since boot, ${bootedAt}) ===`;

		if (r.code !== 0) {
			return `${header}\n(could not collect: ${failure("docker compose logs", r).message})`;
		}

		const text =
			r.stdout.length > MAX_LOG_CHARS
				? `(truncated to last ${MAX_LOG_CHARS} chars)\n${r.stdout.slice(-MAX_LOG_CHARS)}`
				: r.stdout;

		return `${header}\n${text.trimEnd()}`;
	};

	const fileLogs = async (
		src: Extract<LogSource, { type: "file" }>,
	): Promise<string> => {
		const files = await listFiles(src.path, cwd);

		if (files.size === 0) {
			return `=== file logs: ${src.path} ===\n(no files matched)`;
		}

		const sections: string[] = [];

		for (const [path, size] of [...files].sort()) {
			const before = fileSizesAtBoot.get(path);

			let start = 0;

			let how: string;

			if (before === undefined) {
				how = "whole file, created since boot";
			} else if (size < before) {
				how = "whole file, shrank since boot (rotated or truncated)";
			} else {
				start = before;
				how = `appended since boot, bytes ${before}-${size}`;
			}

			if (size - start > MAX_LOG_CHARS) {
				start = size - MAX_LOG_CHARS;
				how += `, truncated to last ${MAX_LOG_CHARS} bytes`;
			}

			const body = await readRange(path, start, size).catch(
				(err: Error) => `(could not read: ${err.message})`,
			);

			sections.push(
				`=== file log: ${path} (${how}) ===\n${body.trimEnd()}`,
			);
		}
		return sections.join("\n\n");
	};

	return {
		baseUrl: app.base_url,
		collectLogs: async () => {
			const parts = await Promise.all(
				config.logs.map((src) =>
					src.type === "docker" ? dockerLogs(src) : fileLogs(src),
				),
			);

			return parts.join("\n\n");
		},
		stop,
	};
}
