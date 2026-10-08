import { parseArgs } from "node:util";
import { Octokit } from "@octokit/rest";
import { githubDataStore } from "../data/github.js";
import { localDataStore } from "../memory/datastore.js";
import { readRecords, type Summary, summarize } from "../metrics/ledger.js";
import { resolveRepo, resolveToken, UsageError } from "./run.js";

const percent = (n: number) => `${Math.round(n * 100)}%`;

export function formatSummary(s: Summary): string {
	return [
		`runs                ${s.runs}`,
		`MTTR to PR          ${s.mttrToPrMinutes === undefined ? "n/a" : `${s.mttrToPrMinutes.toFixed(1)} min`}`,
		`reproduction rate   ${percent(s.reproductionRate)}`,
		`PR merge rate       ${percent(s.prMergeRate)}`,
		`mean cost per run   $${s.meanCostUsd.toFixed(4)}`,
		`no human touches    ${percent(s.noHumanShare)}`,
		`escalated           ${s.escalated}`,
	].join("\n");
}

/** Prints the ledger's summary, from `.fixloop/data` (--local) or the data branch on GitHub. */
export async function metricsCommand(argv: string[]): Promise<number> {
	let values: { local?: boolean; repo?: string };

	try {
		({ values } = parseArgs({
			args: argv,
			options: { local: { type: "boolean" }, repo: { type: "string" } },
			strict: true,
		}));
	} catch (err) {
		throw new UsageError((err as Error).message);
	}

	if (values.repo && !/^[^/\s]+\/[^/\s]+$/.test(values.repo)) {
		throw new UsageError("--repo must be owner/name");
	}

	let store = localDataStore(process.cwd());

	if (!values.local) {
		const [owner, repo] = (await resolveRepo(values.repo)).split("/");

		store = githubDataStore(new Octokit({ auth: await resolveToken() }), {
			owner,
			repo,
		});
	}

	console.log(formatSummary(summarize(await readRecords(store))));

	return 0;
}
