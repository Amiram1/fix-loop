import type { Octokit } from "@octokit/rest";
import type { Delivery, IntakeResult } from "../pipeline/artifacts.js";
import type { RepoRef } from "./github.js";

const LABELS: Record<string, { color: string; description: string }> = {
	fixloop: { color: "5319e7", description: "Handled by FixLoop" },
	"fixloop:draft": {
		color: "fbca04",
		description: "FixLoop opened a draft: a human should check it",
	},
	"fixloop:ready": {
		color: "0e8a16",
		description: "FixLoop passed its gate: ready for review",
	},
	"sev:S1": { color: "b60205", description: "Severity S1" },
	"sev:S2": { color: "d93f0b", description: "Severity S2" },
	"sev:S3": { color: "fbca04", description: "Severity S3" },
	"sev:S4": { color: "c5def5", description: "Severity S4" },
	"area:frontend": { color: "1d76db", description: "Frontend bug" },
	"area:backend": { color: "0052cc", description: "Backend bug" },
};

/** The labels a PR for this fix carries. Severity and area are left out when intake did not run. */
export function labelsFor(
	delivery: Delivery,
	intake: Pick<IntakeResult, "severity" | "area"> | undefined,
	fallbackArea?: "frontend" | "backend",
): string[] {
	const area = intake?.area === "unknown" ? undefined : intake?.area;

	const areaName = area ?? fallbackArea;

	return [
		"fixloop",
		delivery === "ready_pr" ? "fixloop:ready" : "fixloop:draft",
		...(intake ? [`sev:${intake.severity}`] : []),
		...(areaName ? [`area:${areaName}`] : []),
	];
}

/** Creates the labels that do not exist in the repo yet. Returns the names it created. */
export async function ensureLabels(
	octokit: Octokit,
	ref: RepoRef,
	names: string[],
): Promise<string[]> {
	const existing = await octokit.paginate(octokit.issues.listLabelsForRepo, {
		owner: ref.owner,
		repo: ref.repo,
		per_page: 100,
	});

	// GitHub treats label names as case-insensitive.
	const have = new Set(existing.map((l) => l.name.toLowerCase()));

	const created: string[] = [];

	for (const name of names) {
		if (have.has(name.toLowerCase())) continue;

		try {
			await octokit.issues.createLabel({
				owner: ref.owner,
				repo: ref.repo,
				name,
				color: LABELS[name]?.color ?? "ededed",
				description: LABELS[name]?.description,
			});
			created.push(name);
		} catch (err) {
			// Another run created it between the list and now.
			if ((err as { status?: number }).status !== 422) throw err;
		}
	}

	return created;
}
