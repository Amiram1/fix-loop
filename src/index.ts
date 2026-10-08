// Action entry point: route the triggering event, guard it, and post the status skeleton.
import { readFile } from "node:fs/promises";
import { Octokit } from "@octokit/rest";
import { hasLabels, upsertStatusComment } from "./adapters/github.js";
import { guard } from "./pipeline/guard.js";
import { route } from "./router.js";
import { renderStatus } from "./ui/statusComment.js";

export async function main(env = process.env): Promise<void> {
	const eventPath = env.GITHUB_EVENT_PATH;

	const [owner, repo] = (env.GITHUB_REPOSITORY ?? "").split("/");

	if (!eventPath || !owner || !repo)
		throw new Error("GITHUB_EVENT_PATH and GITHUB_REPOSITORY are required");

	const payload = JSON.parse(await readFile(eventPath, "utf8"));

	const command = route({
		name: env.GITHUB_EVENT_NAME ?? "",
		action: payload.action,
		payload,
	});

	const octokit = new Octokit({ auth: env.GITHUB_TOKEN });

	if (command.kind === "ignore") {
		console.log(`fixloop: ignoring event (${command.reason})`);
		return;
	}

	const ref = { owner, repo, issue: command.issue };

	const labels = await hasLabels(octokit, ref);

	const verdict = guard({ command, labels, activeRunForIssue: false });

	if (!verdict.allowed) {
		console.log(`fixloop: not starting (${verdict.reason})`);
		return;
	}

	// Phase A skeleton: only the status comment. Stages are wired in Phase B.
	await upsertStatusComment(
		octokit,
		ref,
		renderStatus({
			runId: env.GITHUB_RUN_ID ?? "local",
			headline: "received",
			stages: [
				{ name: "Intake", state: "pending" },
				{ name: "Reproduce", state: "pending" },
				{ name: "Fix", state: "pending" },
				{ name: "Deliver", state: "pending" },
			],
		}),
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
