/**
 * Contract input schemas — the ONLY place the snake_case (JSON/YAML) ↔ camelCase
 * (TS) boundary is crossed (consistency rule #1 / AR5).
 *
 * Two external inputs are validated here before they reach the domain:
 *  - `task.md` frontmatter — the agent's pre-commitment (`goal`, `allow`).
 *  - `.blastcheck.yml` — the human's optional overrides.
 *
 * Both schemas are LENIENT: unknown keys are ignored and every field is
 * optional, so a malformed-but-parseable input degrades to safe defaults rather
 * than throwing (AR4). Hard parse failures are handled by the caller (`resolve`),
 * which falls back to defaults — checks themselves never see raw external data.
 */

import { z } from "zod";

/** snake_case → camelCase. Used only at this boundary (rule #1). */
function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * `task.md` YAML frontmatter (spec §1.1). `allow` is the agent's declared scope;
 * an absent/empty `allow` is valid (an honest absence of pre-commitment, spec
 * §2 check 2) — it must NOT throw.
 */
export const taskMdSchema = z
  .object({
    goal: z.string().optional(),
    allow: z.array(z.string()).optional(),
  })
  .transform((raw) => ({
    goal: raw.goal ?? null,
    allow: raw.allow ?? [],
  }));

export type TaskMd = z.infer<typeof taskMdSchema>;

/**
 * `.blastcheck.yml` overrides (spec §1.1). Every field is optional — a file with
 * only `deny`, only `budget`, etc. is valid. Threshold keys are score ids in
 * snake_case externally (`scope_adherence`) and mapped to camelCase here.
 *
 * Value ranges are validated: budget counts must be positive integers, churn-%
 * non-negative, and thresholds are scores in `[0, 1]` (spec §4.1). An out-of-range
 * value fails the whole schema → `resolve` logs a warning and degrades to defaults
 * (consistent with how a type error is handled). Empty/whitespace `required_checks`
 * entries are dropped in the transform rather than failing the file — a blank list
 * item is benign noise, not a misconfiguration worth discarding the rest.
 */
export const blastcheckYmlSchema = z
  .object({
    deny: z.array(z.string()).optional(),
    required_checks: z.array(z.string()).optional(),
    budget: z
      .object({
        max_tool_calls: z.number().int().positive().optional(),
        max_files_changed: z.number().int().positive().optional(),
        max_churn_pct: z.number().nonnegative().optional(),
      })
      .optional(),
    thresholds: z.record(z.string(), z.number().min(0).max(1)).optional(),
  })
  .transform((raw) => ({
    deny: raw.deny,
    requiredChecks: raw.required_checks?.map((cmd) => cmd.trim()).filter((cmd) => cmd.length > 0),
    budget: raw.budget
      ? {
          maxToolCalls: raw.budget.max_tool_calls,
          maxFilesChanged: raw.budget.max_files_changed,
          maxChurnPct: raw.budget.max_churn_pct,
        }
      : undefined,
    thresholds: raw.thresholds
      ? Object.fromEntries(Object.entries(raw.thresholds).map(([k, v]) => [snakeToCamel(k), v]))
      : undefined,
  }));

export type BlastcheckYmlOverride = z.infer<typeof blastcheckYmlSchema>;

/**
 * Optional `surfacing:` block in `.blastcheck.yml` — the human's opt-in for the
 * verdict-surfacing egress layer (brief §7). Orthogonal to the scope contract:
 * it tunes what the per-agent reporters do at end-of-turn, never the verdict
 * itself. Both flags default OFF (Slava's §7.2/§7.3 decisions) so the tool stays
 * passive by default; they only widen behavior when explicitly enabled.
 *
 *  - `feedback`: inject the verdict back into the agent's own context (Claude
 *    `additionalContext`, Codex exit-2+stderr, OpenCode `session.prompt`). The
 *    "agent A audits agent B" loop — changes the agent's turn, hence opt-in.
 *  - `block`: hard-block a `fail` (Claude `decision:block`, Codex exit 2). For
 *    CI-style gating; off by default so surfacing never blocks a local session.
 *
 * Lenient like the others: unknown keys ignored, both fields optional.
 */
export const surfacingSchema = z
  .object({
    surfacing: z
      .object({
        feedback: z.boolean().optional(),
        block: z.boolean().optional(),
      })
      .optional(),
  })
  .transform((raw) => ({
    feedback: raw.surfacing?.feedback,
    block: raw.surfacing?.block,
  }));

export type SurfacingOverride = z.infer<typeof surfacingSchema>;
