/**
 * Check runner (AR8, FR16, spec §5).
 *
 * Orchestrates a pass over a set of checks against one {@link CheckContext}:
 *  - `requires`-gating: a check declares the context fields it needs; if any is
 *    absent, the runner returns `skipped(reason)` WITHOUT calling the check —
 *    the thing being constrained never decides whether it can be checked.
 *  - degradation, not refusal: missing data → `skipped`, never `fail` and never
 *    a silent false result; the rest of the checks still run.
 *  - honest `evidence_level`: a coverage profile recording what actually ran
 *    (FR16 scaffold; the finer `partial` level lands with the trajectory loader
 *    in Story 2.1).
 *
 * The runner is a pure function of `(checks, ctx)` — it takes the check list
 * explicitly rather than reaching into the global registry, so it is testable
 * in isolation and free of shared mutable state.
 */

import { log } from "./log.js";
import type {
  Check,
  CheckContext,
  CheckCoverage,
  CheckId,
  CheckResult,
  EvidenceLevel,
  Field,
} from "./types.js";

/** Result of one runner pass: every check's outcome plus the coverage profile. */
export interface RunOutput {
  results: CheckResult[];
  evidenceLevel: EvidenceLevel;
}

/** Maps a declarable {@link Field} to the {@link CheckContext} key that supplies it. */
const FIELD_TO_KEY: Record<Field, keyof CheckContext> = {
  contract: "contract",
  diff: "diff",
  taskMd: "taskMd",
  repoSize: "repoSize",
  trajectory: "trajectory",
};

/** A field is available when its context value is neither `undefined` nor `null`. */
function isAvailable(ctx: CheckContext, field: Field): boolean {
  return ctx[FIELD_TO_KEY[field]] != null;
}

/**
 * Run `checks` against `ctx`, collecting a {@link CheckResult} for each and an
 * {@link EvidenceLevel} profile. Never throws: a check that violates the
 * "never throw" rule (#6) is defensively contained so one buggy check cannot
 * crash the whole audit / CI gate.
 */
export function runChecks(checks: Check[], ctx: CheckContext): RunOutput {
  const results: CheckResult[] = [];
  const coverage: Partial<Record<CheckId, CheckCoverage>> = {};

  for (const check of checks) {
    const missing = check.requires.filter((field) => !isAvailable(ctx, field));
    if (missing.length > 0) {
      results.push({
        check: check.id,
        status: "skipped",
        reason: `missing required data: ${missing.join(", ")}`,
        findings: [],
      });
      coverage[check.id] = "skipped";
      continue;
    }

    let result: CheckResult;
    try {
      result = check.run(ctx);
    } catch (err) {
      // Checks MUST NOT throw (rule #6). If one does, contain it: log and emit a
      // skipped result rather than letting the exception abort the audit.
      log(
        "error",
        `check ${check.id} threw unexpectedly: ${err instanceof Error ? err.message : err}`,
      );
      results.push({
        check: check.id,
        status: "skipped",
        reason: "check raised an unexpected error",
        findings: [],
      });
      coverage[check.id] = "skipped";
      continue;
    }

    results.push(result);
    coverage[check.id] = result.status === "skipped" ? "skipped" : "full";
  }

  return {
    results,
    evidenceLevel: {
      trajectory: ctx.trajectory != null ? "present" : "absent",
      checks: coverage,
    },
  };
}
