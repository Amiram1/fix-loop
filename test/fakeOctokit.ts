// In-memory stand-in for the slice of Octokit that comment and label code uses. Nothing here
// touches the network, so tests can never write to a real issue.
import type { Octokit } from "@octokit/rest";

export interface FakeComment {
	id: number;
	body: string;
	user: { login: string };
	created_at: string;
	updated_at: string;
}

export const REPO = { owner: "o", repo: "r", issue: 7 };

const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });

export function fakeOctokit(
	opts: {
		reporter?: string;
		comments?: FakeComment[];
		/** Labels that exist in the repository. */
		repoLabels?: string[];
		/** Labels on the issue. */
		issueLabels?: string[];
	} = {},
) {
	const state = {
		comments: [...(opts.comments ?? [])],
		repoLabels: new Set(opts.repoLabels ?? []),
		issueLabels: new Set(opts.issueLabels ?? []),
		created: [] as string[],
	};

	let nextId = 1000;

	const octokit = {
		paginate: async (
			fn: (p: unknown) => Promise<{ data: unknown[] }>,
			p: unknown,
		) => (await fn(p)).data,
		issues: {
			listComments: async () => ({ data: state.comments }),
			createComment: async ({ body }: { body: string }) => {
				const id = nextId++;

				const at = new Date().toISOString();

				state.comments.push({
					id,
					body,
					user: { login: "github-actions[bot]" },
					created_at: at,
					updated_at: at,
				});

				return { data: { id } };
			},
			updateComment: async ({
				comment_id,
				body,
			}: {
				comment_id: number;
				body: string;
			}) => {
				const c = state.comments.find((x) => x.id === comment_id);

				if (!c) throw notFound();

				c.body = body;
				c.updated_at = new Date().toISOString();
			},
			get: async () => ({
				data: { user: opts.reporter ? { login: opts.reporter } : null },
			}),
			getLabel: async ({ name }: { name: string }) => {
				if (!state.repoLabels.has(name)) throw notFound();

				return { data: { name } };
			},
			createLabel: async ({ name }: { name: string }) => {
				state.repoLabels.add(name);
				state.created.push(name);
			},
			addLabels: async ({ labels }: { labels: string[] }) => {
				for (const l of labels) state.issueLabels.add(l);
			},
			removeLabel: async ({ name }: { name: string }) => {
				if (!state.issueLabels.delete(name)) throw notFound();
			},
		},
	};

	return { octokit: octokit as unknown as Octokit, state };
}

/** A comment with fixed timestamps, `n` minutes past the hour. */
export function comment(
	id: number,
	login: string,
	body: string,
	minute: number,
	updatedMinute = minute,
): FakeComment {
	const at = (m: number) => `2026-01-01T10:${String(m).padStart(2, "0")}:00Z`;

	return {
		id,
		body,
		user: { login },
		created_at: at(minute),
		updated_at: at(updatedMinute),
	};
}
