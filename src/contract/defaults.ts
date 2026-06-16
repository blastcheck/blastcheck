/**
 * Tool defaults for the parts of the contract the agent does NOT author
 * (spec §1.1, §4.1). These are the bottom layer of the three-source resolve:
 * `.blastcheck.yml` overrides them, but the agent's `task.md` never touches them.
 *
 * Authorship principle: `deny` is a hard gate, so its source is the tool — not
 * the thing it constrains. Thresholds/budgets are starting heuristics (spec
 * §4.1 is explicit they are NOT validated industry standards), overridable.
 */

import type { Budget } from "../types.js";

/**
 * Default deny blacklist (spec §1.1): lockfiles, CI config, migrations, secrets
 * and env files — the security boundary an agent should never cross unprompted.
 * gitignore glob dialect (matched via `ignore`, NFR6).
 */
export const DEFAULT_DENY: readonly string[] = [
  "**/*.lock",
  ".github/**",
  "migrations/**",
  "**/secrets*",
  "**/.env*",
] as const;

/** Default soft budget (spec §2). Overridable in `.blastcheck.yml → budget`. */
export const DEFAULT_BUDGET: Budget = {
  maxToolCalls: 50,
  maxFilesChanged: 10,
  maxChurnPct: 10,
};

/**
 * Default warn-below thresholds (spec §4.1). Keys are camelCase score ids — the
 * snake_case `.blastcheck.yml` keys are mapped to these in `schema.ts` (rule #1).
 * `hard_floor` values live with the verdict engine (Story 1.4), not here.
 */
export const DEFAULT_THRESHOLDS: Record<string, number> = {
  scopeAdherence: 0.9,
  toolEfficiency: 0.6,
  churnDiscipline: 0.5,
  progress: 1.0,
};
