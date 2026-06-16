/**
 * Canonical foundation types for blastcheck.
 *
 * Consistency rules enforced here (see story 1.1 Dev Notes):
 *  - Rule #2: a single canonical `CheckResult`/`Finding` shape is the output of
 *    every check (AR6). Defined verbatim from the architecture's Data Patterns.
 *  - Rule #1/#4: TS surface is camelCase; the JSON↔code boundary (snake_case
 *    external fields) is crossed only through zod schemas in Story 1.2.
 *
 * No check is implemented in this story — only the contracts they build on.
 */

import type { CheckId } from "./checks/registry.js";

// Re-exported so the public type surface (src/index.ts) exposes `CheckId`
// without importing the registry directly.
export type { CheckId } from "./checks/registry.js";

/** Outcome of a single check. `skipped` means the check could not run. */
export type CheckStatus = "pass" | "warn" | "fail" | "skipped";

/**
 * One observation produced by a check. The verdict engine reads `status` and
 * `severity`; it never reads `evidence` (which is debug raw material only).
 */
export interface Finding {
  severity: "info" | "warn" | "high";
  /** Human-readable, single line. */
  message: string;
  /** Normalized POSIX path, when applicable. */
  path?: string;
  /** Raw material for debugging — NOT consumed by the verdict engine. */
  evidence?: Record<string, unknown>;
}

/**
 * Canonical output of every check (consistency rule #2, AR6).
 *
 * Invariants (enforced by the Story 1.2 runner, documented here):
 *  - `status === 'skipped'`  ⇒ `reason` is set, `findings` is `[]`, `score` absent.
 *  - The gate uses `status: 'fail'` + `severity: 'high'`, never `score`.
 */
export interface CheckResult {
  /** Stable string id (consistency rule #3). */
  check: CheckId;
  status: CheckStatus;
  /** 0..1, only for score-based checks. */
  score?: number;
  /** `[]` when status is `pass`. */
  findings: Finding[];
  /** Required ONLY when `status === 'skipped'`. */
  reason?: string;
}

/** A check is either git-only or trajectory class (AR8). */
export type CheckClass = "git-only" | "trajectory";

/**
 * Data fields a check may require from the audit context. The runner gates a
 * check on availability of its required fields (AR8); missing data → `skipped`.
 */
export type Field = "diff" | "taskMd" | "repoSize" | "contract" | "trajectory";

/**
 * Per-check coverage in the evidence profile (FR16). A check that ran reports
 * `full`; one the runner skipped reports `skipped`. The finer `partial` level
 * (a check that ran on a degraded trace) and `absent` land with the trajectory
 * loader in Story 2.1 — this story only builds the scaffold.
 */
export type CheckCoverage = "full" | "partial" | "skipped" | "absent";

/**
 * Honest coverage profile of an audit — NOT a binary flag (spec §5). It records
 * whether a trajectory was present and which checks actually ran, so the tool
 * never claims to have checked something it did not see.
 */
export interface EvidenceLevel {
  trajectory: "present" | "absent";
  checks: Partial<Record<CheckId, CheckCoverage>>;
}

/** A single entry from `git diff --numstat`. `null` count ⇒ binary file. */
export interface DiffEntry {
  /** Normalized POSIX path relative to repo root. */
  path: string;
  added: number | null;
  removed: number | null;
}

/**
 * Audit context handed to each check. Foundation shape — the runner that
 * populates it lands in Story 1.2; trajectory shape lands in Story 2.1.
 */
export interface CheckContext {
  contract: Contract;
  diff?: DiffEntry[];
  taskMd?: string | null;
  repoSize?: number;
  trajectory?: unknown;
}

/**
 * Contract module interface (AR8). A check is a PURE function of its context
 * and MUST NEVER throw — on missing data it returns `skipped(reason)`.
 * Implementations arrive in Story 1.3 (git-only) and 2.2 (trajectory).
 */
export interface Check {
  id: CheckId;
  /** Class attribute is a field of the interface (Dev Notes). */
  cls: CheckClass;
  /** Context fields the runner must provide before this check can run. */
  requires: Field[];
  run(ctx: CheckContext): CheckResult;
}

/** Soft budget (spec §2). Overridable via `.blastcheck.yml → budget`. */
export interface Budget {
  /** Max tool calls before `extraneous-tool-calls` penalizes (check 3). */
  maxToolCalls: number;
  /** Advisory cap on files changed. */
  maxFilesChanged: number;
  /** Churn-% warn threshold; `2×` is the fail threshold (check 4). */
  maxChurnPct: number;
}

/**
 * One required-check pattern (spec §2.5). `cmd` is matched (prefix/regex) against
 * Bash events in the trajectory by the `required-checks` check (Story 2.2).
 *
 * `source` fixes the gate strictness: `auto` (detected from a repo manifest) is a
 * SOFT gate — the tool won't crit-fail the agent for an instruction it invented;
 * `explicit` (written by a human in `.blastcheck.yml`) is a HARD gate.
 */
export interface RequiredCheck {
  cmd: string;
  source: "auto" | "explicit";
}

/**
 * Parsed audit contract, assembled from three trust sources (Story 1.2, FR2):
 *  - `deny`/`budget`/`thresholds` — tool defaults ← `.blastcheck.yml` override.
 *  - `requiredChecks` — manifest autodetect (`auto`) ← `.blastcheck.yml` (`explicit`).
 *  - `allow`/`goal` — read STRICTLY from `git show <baselineSha>:task.md`
 *    (pinned, tamper-proof; HEAD is ignored — FR3).
 *
 * The TS surface is camelCase; the snake_case JSON/YAML boundary is crossed only
 * in `contract/schema.ts` (rule #1 / AR5).
 */
export interface Contract {
  baselineSha: string;
  /** Agent-declared goal from baseline `task.md`; `null` when absent. */
  goal: string | null;
  deny: string[];
  /** Agent-declared in-scope globs; `[]` is valid (no pre-commitment). */
  allow: string[];
  requiredChecks: RequiredCheck[];
  budget: Budget;
  /** Per-score warn-below thresholds (spec §4.1); keyed by camelCase score id. */
  thresholds: Record<string, number>;
}

/** Process exit codes (NFR10). `2` is a tool error, NOT an audit failure. */
export const EXIT = {
  /** Audit passed. */
  OK: 0,
  /** Verdict/gate failed. */
  FAIL: 1,
  /** Tool error (e.g. no git repo / unreadable sha). `2 !== audit failure`. */
  TOOL_ERROR: 2,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
