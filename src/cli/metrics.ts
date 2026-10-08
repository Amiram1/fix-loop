import { parseArgs } from "node:util";
import { Octokit } from "@octokit/rest";
import { githubDataStore } from "../data/github.js";
import { localDataStore } from "../memory/datastore.js";
import { percent, renderDashboard } from "../metrics/dashboard.js";
import { readRecords, type Summary, summarize } from "../metrics/ledger.js";
import { resolveRepo, resolveToken, UsageError } from "./run.js";

const minutes = (m: number | undefined) =>
	m === undefined ? "n/a" : `${m.toFixed(1)} min`;

export function formatSummary(s: Summary): string {
	return [
		`runs                ${s.runs}`,
		`MTTR to PR          ${minutes(s.mttrToPrMinutes)}`,
		`median run time     ${minutes(s.medianRunMinutes)}`,
		`reproduction rate   ${percent(s.reproductionRate)}`,
		`PR merge rate       ${percent(s.prMergeRate)}`,
		`mean cost per run   $${s.meanCostUsd.toFixed(4)}`,
		`no human touches    ${s.noHumanShare === undefined ? "n/a" : percent(s.noHumanShare)}`,
		`escalated           ${s.escalated}`,
	].join("\n");
}

/**
 * Prints the ledger's summary (or, with --markdown, the dashboard page), from `.fixloop/data`
 * (--local) or the data branch on GitHub.
 */
export async function metricsCommand(argv: string[]): Promise<number> {
	let values: { local?: boolean; repo?: string; markdown?: boolean };

	try {
		({ values } = parseArgs({
			args: argv,
			options: {
				local: { type: "boolean" },
				repo: { type: "string" },
				markdown: { type: "boolean" },
			},
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

	const records = await readRecords(store);

	console.log(
		values.markdown
			? renderDashboard(records, new Date())
			: formatSummary(summarize(records)),
	);

	return 0;
}
