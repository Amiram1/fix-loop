// Outputs that earlier stages hand to later ones. Each field is owned by one stage:
// Intake writes `intake`, Context writes `brief`, Boot writes `app`.
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
}
