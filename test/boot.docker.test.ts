// Real-Docker checks for bootApp. Skipped unless opted in, because they pull images and start containers:
//   FIXLOOP_DOCKER_TESTS=1 npx vitest run test/boot.docker.test.ts
//   FIXLOOP_DOCKER_TESTS=1 FIXLOOP_VIKUNJA_DIR=/path/to/vikunja npx vitest run test/boot.docker.test.ts
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { bootApp } from "../src/boot/boot.js";
import { run } from "../src/boot/exec.js";
import { parseConfig } from "../src/config/load.js";

const enabled = process.env.FIXLOOP_DOCKER_TESTS === "1";

const vikunjaDir = process.env.FIXLOOP_VIKUNJA_DIR;

function freePort(): Promise<number> {
	return new Promise((done, fail) => {
		const server = createServer();

		server.once("error", fail);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };

			server.close(() => done(port));
		});
	});
}

async function containerIds(composeArgs: string, cwd: string) {
	const r = await run(`docker compose ${composeArgs} ps -a -q`, { cwd });

	expect(r.code, r.stderr).toBe(0);
	return r.stdout.trim();
}

describe.skipIf(!enabled)("bootApp against real Docker", () => {
	it("boots examples/boot-fixture, collects logs, and removes the containers", async () => {
		const cwd = resolve("examples/boot-fixture");

		const port = await freePort();

		const previous = process.env.FIXLOOP_FIXTURE_PORT;

		process.env.FIXLOOP_FIXTURE_PORT = String(port);

		const config = parseConfig(`
app:
  up: docker compose up -d --wait
  down: docker compose down -v
  base_url: http://127.0.0.1:${port}
  seed: curl -sS -o /dev/null "$FIXLOOP_BASE_URL/fixloop-seed-marker"
  health_timeout_s: 60
logs:
  - { type: docker, services: [web], compose_file: docker-compose.yml }
tests:
  full: "true"
`);

		try {
			const app = await bootApp({ config, cwd });

			try {
				expect(await containerIds("", cwd)).not.toBe("");

				const logs = await app.collectLogs();

				// The seed command ran after boot and the health probe hit the server too.
				expect(logs).toContain("docker logs: web");
				expect(logs).toContain("GET /fixloop-seed-marker");
			} finally {
				await app.stop();
			}

			expect(await containerIds("", cwd)).toBe("");
			await expect(
				fetch(`http://127.0.0.1:${port}`, {
					signal: AbortSignal.timeout(3_000),
				}),
			).rejects.toThrow();
		} finally {
			if (previous === undefined) delete process.env.FIXLOOP_FIXTURE_PORT;
			else process.env.FIXLOOP_FIXTURE_PORT = previous;
		}
	}, 180_000);

	it("tears down when the health check never passes", async () => {
		const cwd = resolve("examples/boot-fixture");

		const port = await freePort();

		const previous = process.env.FIXLOOP_FIXTURE_PORT;

		process.env.FIXLOOP_FIXTURE_PORT = String(port);

		// Points the health check at a port nothing listens on.
		const config = parseConfig(`
app:
  up: docker compose up -d --wait
  down: docker compose down -v
  base_url: http://127.0.0.1:${await freePort()}
  health_timeout_s: 3
tests:
  full: "true"
`);

		try {
			await expect(bootApp({ config, cwd })).rejects.toThrow(
				/did not answer below HTTP 500 within 3s/,
			);
			expect(await containerIds("", cwd)).toBe("");
		} finally {
			if (previous === undefined) delete process.env.FIXLOOP_FIXTURE_PORT;
			else process.env.FIXLOOP_FIXTURE_PORT = previous;
		}
	}, 180_000);
});

describe.skipIf(!enabled || !vikunjaDir)(
	"bootApp against the Vikunja example",
	() => {
		it("boots, seeds a user who can log in, collects logs, and tears down with down -v", async () => {
			const cwd = resolve(vikunjaDir as string);

			const config = parseConfig(
				await readFile("examples/vikunja/.fixloop.yml", "utf8"),
			);

			const app = await bootApp({ config, cwd });

			let logs = "";

			try {
				const login = await fetch(`${app.baseUrl}/api/v1/login`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						username: "fixloop",
						password: "fixloop-test-pw-1",
					}),
				});

				expect(login.status).toBe(200);
				logs = await app.collectLogs();
			} finally {
				await app.stop();
			}

			expect(logs).toContain("docker logs: api");
			expect(logs).toContain("/api/v1/login");
			expect(
				await containerIds("-f docker-compose.fixloop.yml", cwd),
			).toBe("");
		}, 900_000);
	},
);
