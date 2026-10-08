import { riskReasons } from "../gate/gate.js";
import { gateInputFrom } from "../gate/input.js";
import type { GateResult } from "../pipeline/artifacts.js";
import type { RunContext } from "../pipeline/run.js";

/**
 * A model-written sentence as plain Markdown: whitespace collapsed, mentions defused so they do not
 * ping anyone, and cut at a word boundary with an ellipsis rather than mid-sentence.
 */
function plainSentence(text: string, max: number): string {
	const flat = text
		.replace(/\s+/g, " ")
		.replace(/@(?=[\w-])/g, "@\u200b")
		.trim();

	if (flat.length <= max) return flat;

	const cut = flat.slice(0, max);

	const space = cut.lastIndexOf(" ");

	return `${space > 0 ? cut.slice(0, space) : cut}…`;
}

const MAX_EVIDENCE_CHARS = 3000;

const MAX_LINE_CHARS = 200;

/** Inline code that cannot be broken out of by a backtick in the text. */
const inline = (text: string) => `\`${text.replaceAll("`", "'")}\``;

/** A fenced block that is longer than any run of backticks inside it, so the text cannot close it. */
function fenced(text: string): string {
	const longest = Math.max(
		0,
		...(text.match(/`+/g) ?? []).map((run) => run.length),
	);

	const fence = "`".repeat(Math.max(3, longest + 1));

	return `${fence}\n${text}\n${fence}`;
}

const cap = (text: string) =>
	text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}...` : text;

/** First two non-empty lines of the failing output, which usually name the test and the assertion. */
function symptom(evidence: string | undefined): string {
	const lines = (evidence ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.slice(0, 2);

	return lines.length > 0
		? inline(cap(lines.join(" | ")))
		: "no test output was recorded";
}

/**
 * The PR description. The root cause is two lines: what the red test printed, and what the fix
 * changed. The fix result carries no model-written summary, so the second line is measured from the diff.
 * Model-influenced text (test output, names) only appears inside code spans and fences, where
 * GitHub does not turn `@name` into a mention.
 */
export function renderPrBody({
	ctx,
	gate,
}: {
	ctx: RunContext;
	gate: GateResult;
}): string {
	const { reproduction, fix } = ctx.artifacts;

	const input = gateInputFrom(ctx);

	const risks = riskReasons(input, ctx.config.risk);

	const files = fix?.filesChanged ?? [];

	const suite = fix?.status === "fixed" ? "passed" : "not passing";

	const measured = `Changed ${files.length} ${files.length === 1 ? "file" : "files"} (${input.diffLines} changed ${input.diffLines === 1 ? "line" : "lines"}).`;

	const fixLine = fix?.summary
		? `${plainSentence(fix.summary, 600)} ${measured}`
		: measured;

	const test =
		reproduction?.testPath && reproduction.testName
			? `${inline(reproduction.testPath)}, ${inline(reproduction.testName)}`
			: "none recorded";

	const models = fix?.models.length
		? fix.models.map(inline).join(" → ")
		: "none";

	return [
		`Fixes #${ctx.issue.number}`,
		"",
		"## Root cause",
		"",
		`- Failing test output: ${symptom(reproduction?.evidence)}`,
		`- Fix: ${fixLine}`,
		"",
		"## Failing test",
		"",
		test,
		"",
		"## Change",
		"",
		...(files.length > 0 ? files.map((f) => `- ${inline(f)}`) : ["- none"]),
		"",
		`Gate: **${gate.delivery === "ready_pr" ? "ready for review" : "draft PR"}**, confidence ${gate.confidence.toFixed(3)}.`,
		"",
		// The risk reasons get their own section below.
		...gate.reasons.filter((r) => !risks.includes(r)).map((r) => `- ${r}`),
		"",
		"## Risk notes",
		"",
		...(risks.length > 0
			? risks.map((r) => `- ${r}`)
			: [
					"- No high-risk path touched, the issue is not S1, and the diff is within the size limit.",
				]),
		"",
		"<details>",
		"<summary>Evidence</summary>",
		"",
		"Red test output (tail):",
		"",
		fenced(
			(reproduction?.evidence ?? "(none recorded)")
				.trimEnd()
				.slice(-MAX_EVIDENCE_CHARS),
		),
		"",
		`Fix run: ${models}, ${fix?.attempts ?? 0} ${fix?.attempts === 1 ? "attempt" : "attempts"}.`,
		"",
		`Full suite (${inline(ctx.config.tests.full)}): ${suite}.`,
		"",
		"</details>",
		"",
		"<sub>Opened by FixLoop. It never merges: a person reviews and merges.</sub>",
		"",
	].join("\n");
}
