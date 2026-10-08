import { spawn } from "node:child_process";

export interface ExecOptions {
	cwd?: string;
	/** Kills the command (and its process group) after this many ms. No limit when unset. */
	timeoutMs?: number;
	/** Merged over process.env. Values are never printed by FixLoop. */
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

export const run: Exec = (cmd, opts = {}) =>
	new Promise((resolve) => {
		const child = spawn(cmd, {
			shell: true,
			cwd: opts.cwd,
			env: { ...process.env, ...opts.env },
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
