import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Octokit } from "@octokit/rest";

const execFileP = promisify(execFile);

const CODEOWNERS_PATHS = [
	".github/CODEOWNERS",
	"CODEOWNERS",
	"docs/CODEOWNERS",
];

/** How many of the top committers to try before giving up on the git fallback. */
const MAX_CANDIDATES = 5;

/** Maps a commit email to a GitHub login. Returns undefined when the email has no account. */
export type LoginLookup = (email: string) => Promise<string | undefined>;

export interface ReviewerQuery {
	/** Checkout the CODEOWNERS file and the git history are read from. */
	root: string;
	changedFiles: string[];
	/** GitHub login of the issue reporter. They are never picked as the reviewer. */
	issueAuthor?: string;
	/** Needed only for the git fallback. Without it the fallback reports why it cannot pick anyone. */
	lookupLogin?: LoginLookup;
	/**
	 * Whether a login is a collaborator on the repo. A candidate who is not is skipped, because
	 * GitHub cannot request them as a reviewer. Without it every candidate is accepted.
	 */
	isCollaborator?: (login: string) => Promise<boolean>;
}

export interface ReviewerResult {
	/** GitHub login, without "@". */
	reviewer?: string;
	/** Where the reviewer came from, or why there is none. For the PR detail. */
	reason: string;
}

interface Rule {
	pattern: RegExp;
	owners: string[];
}

const escapeRegex = (c: string) => c.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/**
 * A CODEOWNERS pattern as a regex over repo-relative paths, with gitignore rules: a pattern with a
 * slash at the start or middle is anchored to the root, otherwise it matches at any depth. A trailing
 * "/" means a directory, and a name without wildcards in its last part also covers what is below it.
 * `docs/*` is not covered by that rule, so it matches direct children only, as on GitHub.
 * ponytail: no character classes and no escaped spaces, which CODEOWNERS does not support either.
 */
function patternRegex(raw: string): RegExp {
	const dirOnly = raw.endsWith("/");

	const pattern = dirOnly ? raw.slice(0, -1) : raw;

	const anchored = pattern.includes("/");

	const body = pattern.replace(/^\//, "");

	let re = "";

	for (let i = 0; i < body.length; i++) {
		const c = body.charAt(i);

		if (c === "*" && body[i + 1] === "*") {
			if (body[i + 2] === "/") {
				re += "(?:.*/)?";
				i += 2;
			} else {
				re += ".*";
				i += 1;
			}
		} else if (c === "*") re += "[^/]*";
		else if (c === "?") re += "[^/]";
		else if (c === "\\" && i + 1 < body.length)
			re += escapeRegex(body.charAt(++i));
		else re += escapeRegex(c);
	}

	const lastPart = body.slice(body.lastIndexOf("/") + 1);

	const below = dirOnly ? "/.*" : /[*?]/.test(lastPart) ? "" : "(?:/.*)?";

	return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${re}${below}$`);
}

function parseRules(text: string): Rule[] {
	const rules: Rule[] = [];

	for (const line of text.split(/\r?\n/)) {
		const [pattern, ...rest] = line.trim().split(/\s+/);

		if (!pattern || pattern.startsWith("#")) continue;

		const comment = rest.findIndex((token) => token.startsWith("#"));

		rules.push({
			pattern: patternRegex(pattern),
			owners: comment === -1 ? rest : rest.slice(0, comment),
		});
	}

	return rules;
}

async function readCodeowners(root: string): Promise<Rule[]> {
	for (const path of CODEOWNERS_PATHS) {
		try {
			return parseRules(await readFile(join(root, path), "utf8"));
		} catch {
			// Not at this location: try the next.
		}
	}

	return [];
}

const sameLogin = (a: string, b: string | undefined) =>
	b !== undefined &&
	a.replace(/^@/, "").toLowerCase() === b.replace(/^@/, "").toLowerCase();

/** The first owner of the first changed file that has one a reviewer can be requested from. */
function ownerFromRules(
	rules: Rule[],
	files: string[],
	issueAuthor: string | undefined,
): string | undefined {
	for (const file of files) {
		// The last matching rule wins, and a rule with no owners clears ownership.
		const rule = [...rules].reverse().find((r) => r.pattern.test(file));

		// "@org/team" owners and bare emails cannot be requested as a user review.
		const owner = rule?.owners.find(
			(o) =>
				o.startsWith("@") &&
				!o.includes("/") &&
				!sameLogin(o, issueAuthor),
		);

		if (owner) return owner.slice(1);
	}

	return undefined;
}

/** Commit emails for the files, most frequent first. */
async function topEmails(root: string, files: string[]): Promise<string[]> {
	const counts = new Map<string, number>();

	for (const file of files) {
		const { stdout } = await execFileP(
			"git",
			["log", "--format=%ae", "--", file],
			{ cwd: root, maxBuffer: 16 * 1024 * 1024 },
		);

		for (const email of stdout.split("\n")) {
			if (email) counts.set(email, (counts.get(email) ?? 0) + 1);
		}
	}

	return [...counts].sort((a, b) => b[1] - a[1]).map(([email]) => email);
}

/**
 * Who to ask to review: the CODEOWNERS owner of the changed files, else the person who changed
 * those files most. Never the issue author, and never a failure: with no one to ask, the reason says why.
 */
export async function reviewerFor(
	query: ReviewerQuery,
): Promise<ReviewerResult> {
	const { root, changedFiles, issueAuthor, lookupLogin, isCollaborator } =
		query;

	// A check that fails counts as "not a collaborator": a reviewer request that cannot be made
	// would fail later anyway.
	const allowed = async (login: string): Promise<boolean> => {
		if (!isCollaborator) return true;

		try {
			return await isCollaborator(login);
		} catch {
			return false;
		}
	};

	const owner = ownerFromRules(
		await readCodeowners(root),
		changedFiles,
		issueAuthor,
	);

	if (owner && (await allowed(owner))) {
		return { reviewer: owner, reason: "CODEOWNERS" };
	}

	if (!lookupLogin) {
		return {
			reason: "no CODEOWNERS owner, and no GitHub lookup to map commit emails to logins",
		};
	}

	let emails: string[];

	try {
		emails = await topEmails(root, changedFiles);
	} catch (err) {
		return {
			reason: `no CODEOWNERS owner, and git history could not be read: ${(err as Error).message}`,
		};
	}

	if (emails.length === 0)
		return {
			reason: "no CODEOWNERS owner and no git history for the changed files",
		};

	for (const email of emails.slice(0, MAX_CANDIDATES)) {
		let login: string | undefined;

		try {
			login = await lookupLogin(email);
		} catch (err) {
			return {
				reason: `no CODEOWNERS owner, and the login lookup failed: ${(err as Error).message}`,
			};
		}

		if (login && !sameLogin(login, issueAuthor) && (await allowed(login)))
			return {
				reviewer: login,
				reason: "most frequent author in git history",
			};
	}

	return {
		reason: "no CODEOWNERS owner, and no top committer is a collaborator on the repo other than the issue author",
	};
}

/**
 * Email to login through GitHub: noreply addresses carry the login, others go through user search,
 * which finds only people with a public email.
 */
export function githubLoginLookup(octokit: Octokit): LoginLookup {
	return async (email) => {
		const noreply =
			/^(?:\d+\+)?([^@+]+)@users\.noreply\.github\.com$/i.exec(
				email,
			)?.[1];

		if (noreply) return noreply.endsWith("[bot]") ? undefined : noreply;

		const { data } = await octokit.search.users({
			q: `${email} in:email`,
			per_page: 1,
		});

		return data.items[0]?.login;
	};
}

/**
 * Whether a login is a collaborator on the repo, through GitHub's collaborator endpoint.
 * 404 means "no", any other failure is thrown and treated as "no" by reviewerFor.
 */
export function collaboratorCheck(
	octokit: Octokit,
	ref: { owner: string; repo: string },
): (login: string) => Promise<boolean> {
	return async (login) => {
		try {
			await octokit.repos.checkCollaborator({
				owner: ref.owner,
				repo: ref.repo,
				username: login,
			});
			return true;
		} catch (err) {
			if ((err as { status?: number }).status === 404) return false;

			throw err;
		}
	};
}
