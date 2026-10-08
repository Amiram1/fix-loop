// Prepares untrusted issue text for a prompt: wraps it in a labelled data block and defuses the
// most common ways text tries to escape that block or pose as instructions.
//
// This is hygiene, not a guarantee. It does NOT catch homoglyphs, text in other languages,
// encoded payloads (base64), or paraphrased instructions. The real defences are that the system
// prompt says the block is data, and that no tool permission ever depends on issue content.
// Matches are neutralised in place (the rest of the text is left alone) and reported through
// `injectionSuspected`. "User:" lines are not flagged because bug reports use them constantly.

export const UNTRUSTED_TAG = "untrusted_issue";

export interface Sanitized {
	text: string;
	injectionSuspected: boolean;
}

// Zero-width and bidi control characters, minus U+200D (joins emoji). Removed so they cannot
// split a keyword and slip past the patterns below.
const INVISIBLE = /[​‌‎‏‪-‮⁠-⁤⁦-⁩﻿]/g;

// A `<` that starts a tag we use as a delimiter or that imitates a chat/tool turn
// (also `<|im_start|>`-style special tokens). Only the `<` is escaped, so the text stays readable.
const DELIMITER_TAG =
	/<(?=\s*\/?\s*(?:untrusted_issue|open_issues|system|assistant|developer|tool_use|tool_result|function_calls|instructions?)\b|\|)/gi;

// A line that starts like a chat turn: "SYSTEM:", "**Assistant**:", "> [system]:", "Human:".
const ROLE_LINE =
	/^([ \t>*_#[-]*)((?:system|assistant|developer|human)[*_\]]*[ \t]*(?:\([^)\n]*\))?[ \t]*:)/gim;

const INSTRUCTION_PHRASES: RegExp[] = [
	// "ignore previous instructions", "disregard all the above rules", "forget your instructions"
	/\b(?:ignore|disregard|forget|override)\s+(?:(?:all|any|the|your|these|those|previous|prior|above|earlier|preceding)\s+)+(?:instructions?|prompts?|rules?|directives?|messages?|context)\b/gi,
	/\byou\s+are\s+now\s+(?:a|an|in)\b/gi,
	/\bnew\s+instructions?\s*:/gi,
	/\b(?:reveal|print|show|repeat)\s+(?:your\s+|the\s+)?(?:system\s+prompt|hidden\s+instructions)\b/gi,
];

/** Defuses delimiter tags, role-like lines and instruction phrases in one piece of text. */
export function neutralise(raw: string): Sanitized {
	let injectionSuspected = false;

	const flag = (replacement: string) => {
		injectionSuspected = true;
		return replacement;
	};

	let text = raw.replace(INVISIBLE, "");

	text = text.replace(DELIMITER_TAG, () => flag("&lt;"));
	text = text.replace(ROLE_LINE, (_m, lead: string, role: string) =>
		flag(`${lead}[neutralised] ${role}`),
	);

	for (const pattern of INSTRUCTION_PHRASES) {
		text = text.replace(pattern, (m) => flag(`[neutralised: ${m}]`));
	}

	return { text, injectionSuspected };
}

/** Returns the issue as one `<untrusted_issue>` block, safe to place in a user message. */
export function sanitizeIssueText(
	title: string,
	body: string,
	replies: string[] = [],
): Sanitized {
	const t = neutralise(title.replace(/\s+/g, " ").trim());

	const b = neutralise(body.trim());

	// The reporter's answers to a needs-info question come after the body, in order. They are
	// untrusted in the same way, so they go through the same neutralising.
	const answered = replies.map((reply) => neutralise(reply.trim()));

	return {
		text: [
			`<${UNTRUSTED_TAG}>`,
			`Title: ${t.text}`,
			"Body:",
			b.text || "(empty)",
			...(answered.length > 0
				? [
						"Reporter replies, in order:",
						...answered.map(
							(r, i) => `${i + 1}. ${r.text || "(empty)"}`,
						),
					]
				: []),
			`</${UNTRUSTED_TAG}>`,
		].join("\n"),
		injectionSuspected:
			t.injectionSuspected ||
			b.injectionSuspected ||
			answered.some((r) => r.injectionSuspected),
	};
}
