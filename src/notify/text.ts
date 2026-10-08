// Helpers for putting untrusted or model-written text into a comment without letting it break the
// layout or ping anyone: inline code spans do not render markdown or @mentions.

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/** One-line inline code span, cut to `max` characters (keeping the end when `keep` is "end"). */
export function inline(
	text: string,
	max = 200,
	keep: "start" | "end" = "start",
): string {
	const flat = collapse(text).replaceAll("`", "'");

	if (flat.length <= max) return `\`${flat}\``;

	return keep === "start"
		? `\`${flat.slice(0, max)}…\``
		: `\`…${flat.slice(flat.length - max)}\``;
}

/** A fenced block that cannot be closed early by backticks in the text. */
export function fenced(text: string): string {
	return ["```text", text.replaceAll("```", "'''"), "```"].join("\n");
}
