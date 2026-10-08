#!/usr/bin/env node
import { main } from "./cli/main.js";

// Local development: pick up .env if present. Variables already set in the environment win.
try {
	process.loadEnvFile(".env");
} catch {
	// No .env file; rely on the real environment.
}

main(process.argv.slice(2)).then((code) => {
	process.exitCode = code;
});
