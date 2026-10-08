import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { ConfigSchema, type FixLoopConfig } from "./schema.js";

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

/** Parse and validate a `.fixloop.yml` document. Throws ConfigError with readable paths. */
export function parseConfig(source: string): FixLoopConfig {
	let raw: unknown;

	try {
		raw = parse(source);
	} catch (err) {
		throw new ConfigError(
			`.fixloop.yml is not valid YAML: ${(err as Error).message}`,
		);
	}

	const result = ConfigSchema.safeParse(raw ?? {});

	if (!result.success) {
		const lines = result.error.issues.map(
			(i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`,
		);

		throw new ConfigError(`Invalid .fixloop.yml:\n${lines.join("\n")}`);
	}

	return result.data;
}

export async function loadConfig(
	path = ".fixloop.yml",
): Promise<FixLoopConfig> {
	let source: string;

	try {
		source = await readFile(path, "utf8");
	} catch {
		throw new ConfigError(
			`No ${path} found. Run \`fixloop init\` or add one to the repo root.`,
		);
	}
	return parseConfig(source);
}
