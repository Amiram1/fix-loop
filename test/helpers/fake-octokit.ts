import type { Octokit } from "@octokit/rest";

type Args = Record<string, unknown>;

export interface FakeOptions {
	/** Names of the labels the repo already has. */
	labels?: string[];
	/** PRs that are already open, for any branch. */
	openPulls?: {
		number: number;
		html_url: string;
		draft: boolean;
		head: string;
	}[];
	/** Branches that already exist. */
	branches?: string[];
	issueAuthor?: string;
	requestReviewersError?: string;
	/** Email to login for `search.users`. */
	users?: Record<string, string>;
	/** Logins that are collaborators on the repo. Unset means everyone is. */
	collaborators?: string[];
	/** Author names of the commits on an existing branch, beyond the base. For the overwrite check. */
	branchAuthors?: string[];
}

/** The calls that change something on GitHub. Every other call is a read. */
export const WRITES = [
	"issues.createLabel",
	"issues.addLabels",
	"git.createBlob",
	"git.createTree",
	"git.createCommit",
	"git.createRef",
	"git.updateRef",
	"pulls.create",
	"pulls.update",
	"pulls.requestReviewers",
];

/** An Octokit that keeps state in memory and records every call as [name, args]. */
export function fakeOctokit(options: FakeOptions = {}) {
	const calls: [string, Args][] = [];

	const labels = new Set(options.labels ?? []);

	const pulls = [...(options.openPulls ?? [])];

	const branches = new Set(options.branches ?? []);

	let blobs = 0;

	const rec =
		<T>(name: string, impl: (args: Args) => T) =>
		async (args: Args = {}) => {
			calls.push([name, args]);

			return impl(args);
		};

	const notFound = () =>
		Object.assign(new Error("Not Found"), { status: 404 });

	const listLabelsForRepo = rec("issues.listLabelsForRepo", () => ({
		data: [...labels].map((name) => ({ name })),
	}));

	const repos = {
		compareCommits: rec("repos.compareCommits", () => ({
			data: {
				commits: (options.branchAuthors ?? []).map((name, i) => ({
					sha: `c${i}`,
					commit: { author: { name } },
				})),
			},
		})),
		checkCollaborator: rec("repos.checkCollaborator", ({ username }) => {
			if (
				options.collaborators &&
				!options.collaborators.includes(String(username))
			) {
				throw notFound();
			}

			return { status: 204 };
		}),
	};

	const octokit = {
		// The real paginate takes the endpoint method; here it just calls it and returns its data.
		paginate: async (
			fn: (a: Args) => Promise<{ data: unknown[] }>,
			args: Args,
		) => (await fn(args)).data,
		issues: {
			listLabelsForRepo,
			get: rec("issues.get", () => ({
				data: { user: { login: options.issueAuthor } },
			})),
			createLabel: rec("issues.createLabel", (a) => {
				labels.add(String(a.name));

				return { data: {} };
			}),
			addLabels: rec("issues.addLabels", () => ({ data: [] })),
		},
		repos: {
			...repos,
			get: rec("repos.get", () => ({ data: { default_branch: "main" } })),
		},
		git: {
			createBlob: rec("git.createBlob", () => ({
				data: { sha: `blob-${++blobs}` },
			})),
			createTree: rec("git.createTree", () => ({
				data: { sha: "tree-new" },
			})),
			createCommit: rec("git.createCommit", () => ({
				data: { sha: "commit-new" },
			})),
			getRef: rec("git.getRef", (a) => {
				if (!branches.has(String(a.ref).replace(/^heads\//, "")))
					throw notFound();

				return { data: {} };
			}),
			createRef: rec("git.createRef", (a) => {
				branches.add(String(a.ref).replace(/^refs\/heads\//, ""));

				return { data: {} };
			}),
			updateRef: rec("git.updateRef", () => ({ data: {} })),
		},
		pulls: {
			list: rec("pulls.list", (a) => ({
				data: pulls.filter((p) => a.head === `o:${p.head}`),
			})),
			create: rec("pulls.create", (a) => {
				const pr = {
					number: 100 + pulls.length,
					html_url: `https://github.test/o/r/pull/${100 + pulls.length}`,
					draft: Boolean(a.draft),
					head: String(a.head),
				};

				pulls.push(pr);

				return { data: pr };
			}),
			update: rec("pulls.update", () => ({ data: {} })),
			requestReviewers: rec("pulls.requestReviewers", () => {
				if (options.requestReviewersError) {
					throw new Error(options.requestReviewersError);
				}

				return { data: {} };
			}),
		},
		search: {
			users: rec("search.users", (a) => {
				const email = String(a.q).replace(" in:email", "");

				const login = options.users?.[email];

				return { data: { items: login ? [{ login }] : [] } };
			}),
		},
	};

	const called = (name: string) =>
		calls.filter(([n]) => n === name).map(([, args]) => args);

	return {
		octokit: octokit as unknown as Octokit,
		calls,
		called,
		writes: () => calls.filter(([n]) => WRITES.includes(n)),
	};
}
