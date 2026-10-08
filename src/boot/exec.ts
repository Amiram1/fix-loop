import { spawn } from "node:child_process";

export interface ExecOptions {
	cwd?: string;
	/** Kills the command (and its process group) after this many ms. No limit when unset. */
	timeoutMs?: number;
	/** Merged over the allowlisted environment (see `commandEnv`). Values are never printed by FixLoop. */
	env?: Record<string, string>;
}

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Runs a shell command. Never rejects: spawn errors and timeouts come back as a non-zero code. */
export type Exec = (cmd: string, opts?: ExecOptions) => Promise<ExecResult>;

/** Output kept per stream. Docker builds are chatty and only the tail explains a failure. */
const MAX_OUTPUT_CHARS = 1_000_000;

function keepTail(text: string): string {
	return text.length > MAX_OUTPUT_CHARS
		? text.slice(-MAX_OUTPUT_CHARS)
		: text;
}

/**
 * Variables a command may inherit. Commands run tests that the agent wrote from untrusted issue text,
 * so they must not see FixLoop's own secrets (the model key, the GitHub token, and anything else),
 * and must not get the network-level credentials a runner carries. Config-provided env is added on
 * top of this list by the caller.
 */
const INHERITED = [
	"PATH",
	"HOME",
	"USER",
	"SHELL",
	"LANG",
	"LC_ALL",
	"TERM",
	"TMPDIR",
	"CI",
	"RUNNER_TEMP",
	"RUNNER_OS",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"PNPM_HOME",
	"GOROOT",
	"GOPATH",
	"GOCACHE",
	"GOMODCACHE",
	"GOFLAGS",
	"GOTOOLCHAIN",
	"GOPROXY",
	"GOSUMDB",
	"GOPRIVATE",
	"DOCKER_HOST",
	"DOCKER_CONFIG",
];

/** The inherited variables that are set, and nothing else. */
export function commandEnv(
	source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const env: Record<string, string> = {};

	for (const name of INHERITED) {
		const value = source[name];

		if (value !== undefined) env[name] = value;
	}

	return env;
}

export const run: Exec = (cmd, opts = {}) =>
	new Promise((resolve) => {
		const child = spawn(cmd, {
			shell: true,
			cwd: opts.cwd,
			env: { ...commandEnv(), ...opts.env },
			// Own process group so a timeout can kill the whole shell tree, not just the shell.
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";

		let stderr = "";

		let timedOut = false;

		let settled = false;

		let timer: NodeJS.Timeout | undefined;

		const finish = (code: number) => {
			if (settled) return;

			settled = true;
			clearTimeout(timer);

			if (timedOut) {
				stderr += `\ncommand timed out after ${opts.timeoutMs}ms`;
			}

			resolve({ code, stdout, stderr });
		};

		if (opts.timeoutMs) {
			timer = setTimeout(() => {
				timedOut = true;
				try {
					if (child.pid && process.platform !== "win32") {
						process.kill(-child.pid, "SIGKILL");
					} else {
						child.kill("SIGKILL");
					}
				} catch {
					// already gone
				}
				// Do not wait for "close": a surviving grandchild could hold the pipes open.
				finish(124);
			}, opts.timeoutMs);
		}

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (d: string) => {
			stdout = keepTail(stdout + d);
		});
		child.stderr.on("data", (d: string) => {
			stderr = keepTail(stderr + d);
		});
		child.on("error", (err) => {
			stderr += `\n${err.message}`;
			finish(127);
		});
		// "close" fires after the stdio streams end, so output is complete here.
		child.on("close", (code) => finish(code ?? 1));
	});
