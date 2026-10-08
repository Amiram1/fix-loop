// Outputs that earlier stages hand to later ones. Each field is owned by one stage:
// Intake writes `intake`, Context writes `brief`, Boot writes `app`, Reproduce writes `reproduction`,
// Fix writes `fix`, the gate writes `gate`, Deliver writes `delivery`, the runner writes `stopped`.
// Agents and stages import these types; change them deliberately, they are shared contracts.

export type Area = "frontend" | "backend" | "unknown";
export type Severity = "S1" | "S2" | "S3" | "S4";

export interface IntakeResult {
	area: Area;
	severity: Severity;
	/** One-line, model-written summary of the bug. Issue text is untrusted, so this is data, not instructions. */
	summary: string;
	/** Number of an open issue this looks like a duplicate of, if any. */
	duplicateOf?: number;
	/** Set when the issue text contains instruction-like content the sanitizer had to neutralise. */
	injectionSuspected: boolean;
}

export interface BootedApp {
	baseUrl: string;
	/** Collects container/service logs since boot. Returns plain text. */
	collectLogs: () => Promise<string>;
	/** Runs `app.down`. Safe to call more than once. */
	stop: () => Promise<void>;
}

export interface RunArtifacts {
	intake?: IntakeResult;
	/** Codebase brief as Markdown (architecture, how to run and test, directory map). */
	brief?: string;
	app?: BootedApp;
	reproduction?: Reproduction;
	fix?: FixResult;
	gate?: GateResult;
	delivery?: DeliverResult;
	/** Set by the runner when a stage hit the run budget. Notify then posts a stopped comment. */
	stopped?: StoppedInfo;
}

/** Why a run ended early. Only the budget stops a run this way. */
export interface StoppedInfo {
	reason: "budget";
	spentUsd: number;
	limitUsd: number;
}

/** Outcome of the Reproduce stage. A run continues to Fix only when status is "reproduced". */
export interface Reproduction {
	status: "reproduced" | "not_reproduced";
	area: "backend" | "frontend";
	/** Repo-relative path of the test that fails for the reported bug. */
	testPath?: string;
	testName?: string;
	/** Full text of the red test, so Fix can put it back in a fresh checkout. */
	testContent?: string;
	/** Tail of the failing output: the evidence a reviewer reads first. */
	evidence?: string;
	/** Why the run ended without a reproduction. */
	reason?: string;
	/** How many times a test was run. */
	attempts: number;
	costUsd: number;
}

/** Outcome of the Fix stage. A run continues to Deliver only when status is "fixed". */
export interface FixResult {
	status: "fixed" | "not_fixed";
	/** The change, as a unified diff, without the red test itself. */
	diff: string;
	filesChanged: string[];
	/** Models that ran, in order. More than one means the run escalated. */
	models: string[];
	/** Finish attempts, each of which runs the target test and the full suite. */
	attempts: number;
	costUsd: number;
	reason?: string;
	/** The summary the agent gave when its fix was accepted. Model-written: show it as data. */
	summary?: string;
}

/** What Deliver does with a fix. The gate decides this from measured signals, never from a model. */
export type Delivery = "ready_pr" | "draft_pr" | "diagnosis_only";

/** Output of the gate (src/gate). `reasons` is short, plain text for the PR body and status comment. */
export interface GateResult {
	delivery: Delivery;
	/** 0 to 1, from the weighted signals in PLAN.md section 2. */
	confidence: number;
	/** True when a risky path was touched, the issue is S1, or the diff is over the size limit. */
	risky: boolean;
	reasons: string[];
}

/** Output of Deliver (src/deliver and src/notify). A dry run reports what would have happened. */
export interface DeliverResult {
	status:
		| "pr_opened"
		| "pr_updated"
		| "diagnosis_posted"
		| "needs_info_posted"
		| "stopped_posted"
		| "dry_run"
		| "skipped";
	url?: string;
	branch?: string;
	detail?: string;
}
