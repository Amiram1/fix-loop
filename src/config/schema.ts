import { z } from "zod";

const globList = z.array(z.string().min(1)).default([]);

export const LogSourceSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("docker"),
		services: z.array(z.string().min(1)).min(1),
		/** Passed as `docker compose -f` when collecting logs. Omit to use compose's default file lookup. */
		compose_file: z.string().min(1).optional(),
	}),
	z.object({ type: z.literal("file"), path: z.string().min(1) }),
]);

export const ConfigSchema = z.object({
	app: z.object({
		up: z.string().min(1),
		down: z.string().min(1).optional(),
		base_url: z.string().url(),
		seed: z.string().min(1).optional(),
		health_timeout_s: z.number().int().positive().default(120),
	}),
	logs: z.array(LogSourceSchema).default([]),
	traces: z
		.object({ type: z.literal("otel-file"), path: z.string().min(1) })
		.optional(),
	tests: z.object({
		backend: z
			.object({
				run: z.string().min(1),
				dir: z.string().default("."),
				new_test_glob: z.string().min(1),
			})
			.optional(),
		frontend: z
			.object({
				run: z.string().min(1),
				dir: z.string().default("."),
				new_test_glob: z.string().min(1),
			})
			.optional(),
		e2e: z
			.object({
				run: z.string().min(1),
				dir: z.string().default("."),
				new_test_glob: z.string().min(1),
				/** Non-secret values the e2e command needs, e.g. the seeded test user. Passed to the command, never logged. */
				env: z.record(z.string(), z.string()).default({}),
				/** Existing helpers the agent should reuse (e.g. a login function and its file), one sentence. */
				helpers: z.string().min(1).optional(),
			})
			.optional(),
		full: z.string().min(1),
	}),
	areas: z
		.object({ backend: globList, frontend: globList })
		.default({ backend: [], frontend: [] }),
	risk: z
		.object({
			high_paths: globList,
			max_diff_lines: z.number().int().positive().default(150),
		})
		.default({ high_paths: [], max_diff_lines: 150 }),
	autonomy: z
		.object({
			ready_pr_min_confidence: z.number().min(0).max(1).default(0.8),
			draft_pr_min_confidence: z.number().min(0).max(1).default(0.5),
		})
		.default({
			ready_pr_min_confidence: 0.8,
			draft_pr_min_confidence: 0.5,
		}),
	budget: z
		.object({
			per_run_usd: z.number().positive().default(1.5),
			max_fix_iterations: z.number().int().positive().default(4),
			/** Model turns the reproduce agent gets before it gives up. */
			max_reproduce_turns: z.number().int().positive().default(20),
			/** Model turns the fix agent gets across all its attempts. */
			max_fix_turns: z.number().int().positive().default(30),
		})
		.default({
			per_run_usd: 1.5,
			max_fix_iterations: 4,
			max_reproduce_turns: 20,
			max_fix_turns: 30,
		}),
	models: z
		.object({
			triage: z.string().default("claude-haiku-5-5"),
			fix: z.string().default("claude-sonnet-5-5"),
			escalate: z.string().default("claude-opus-5-5"),
		})
		.default({
			triage: "claude-haiku-5-5",
			fix: "claude-sonnet-5-5",
			escalate: "claude-opus-5-5",
		}),
	/** Effort per stage: how hard the model thinks. Production defaults; development configs lower them. */
	effort: z
		.object({
			triage: z
				.enum(["low", "medium", "high", "xhigh", "max"])
				.default("low"),
			reproduce: z
				.enum(["low", "medium", "high", "xhigh", "max"])
				.default("medium"),
			fix: z
				.enum(["low", "medium", "high", "xhigh", "max"])
				.default("medium"),
			escalate: z
				.enum(["low", "medium", "high", "xhigh", "max"])
				.default("high"),
		})
		.default({
			triage: "low",
			reproduce: "medium",
			fix: "medium",
			escalate: "high",
		}),
	notify: z
		.object({
			slack: z
				.object({
					min_severity: z
						.enum(["S1", "S2", "S3", "S4"])
						.default("S2"),
					on: z
						.array(z.enum(["escalation", "pr_ready"]))
						.default(["escalation"]),
				})
				.optional(),
			linear: z
				.object({ enabled: z.boolean().default(false) })
				.default({ enabled: false }),
		})
		.default({ linear: { enabled: false } }),
});

export type FixLoopConfig = z.infer<typeof ConfigSchema>;
