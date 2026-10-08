import { VERSION } from "../version.js";
import { pingCommand } from "./ping.js";
import { parseRunArgs, runCommand, UsageError } from "./run.js";

const USAGE = `fixloop ${VERSION}

Usage:
  fixloop run --issue <n> [--repo owner/name] [--config .fixloop.yml]
              [--dev] [--dry-run] [--stage <name>]

Options:
  --issue <n>     issue to run against (required)
  --repo          owner/name; defaults to GITHUB_REPOSITORY, then the origin remote
  --config        path to .fixloop.yml (default: .fixloop.yml)
  --dev           force every stage onto Haiku
  --dry-run       print status updates instead of writing to GitHub
  --stage <name>  run only this stage; the others are marked not selected

  fixloop ping [--model <id>]   one low-effort call to check the key and its cost (default: claude-haiku-5-5)
`;

/** Dispatches the CLI. Returns the process exit code: 0 ok, 1 run failed, 2 usage error. */
export async function main(argv: string[]): Promise<number> {
	const [command, ...rest] = argv;

	try {
		if (command === "--version" || command === "-v") {
			console.log(VERSION);
			return 0;
		}

		if (!command || command === "--help" || command === "-h") {
			console.log(USAGE);
			return command ? 0 : 2;
		}

		if (command === "run") return await runCommand(parseRunArgs(rest));

		if (command === "ping") return await pingCommand(rest);

		throw new UsageError(`unknown command "${command}"`);
	} catch (err) {
		if (err instanceof UsageError) {
			console.error(`fixloop: ${err.message}\n\n${USAGE}`);
			return 2;
		}

		console.error(`fixloop: ${(err as Error).message}`);
		return 1;
	}
}
