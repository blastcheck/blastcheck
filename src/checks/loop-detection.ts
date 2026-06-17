/**
 * Check `loop-detection` — is the agent making progress, or spinning? (FR11).
 * Class: trajectory. Produces `score = progress`, BINARY in v1: `0` if any loop
 * pattern is detected, else `1`. Detected patterns become `warn` findings;
 * `progress` has no hard floor, so a loop yields `warn`, not `fail` (deliberate
 * for v1).
 *
 * Four patterns over the step-ordered events (`ctx.trajectory.events` is already
 * sorted by `step`):
 *  - ACTION LOOP: the same NON-recon `signature` appears ≥ `L` times within any
 *    window of `W` consecutive events.
 *  - STUCK LOOP: the same non-zero `exitCode` ≥ `L` times in a row. If NO event
 *    carries an exit code (`coverage.hasExitCode === false`), this sub-check is
 *    not run (per-field degradation, not a failure).
 *  - EDIT CHURN: the same file path is edited ≥ `E` times (total).
 *  - SPINNING: ≥ `K` consecutive steps introduce no previously-unseen file path.
 *
 * Thresholds are module-level constants in v1; making them configurable via
 * `.blastcheck.yml` is deferred (the `Budget`/`Contract` carry no loop params).
 */

import { signature, signatureKey } from "../match/signature.js";
import type { Check, CheckContext, CheckResult, Finding, TrajectoryEvent } from "../types.js";

/** Repeats of one signature/exit-code that constitute a loop. */
const L = 3;
/** Window size (consecutive events) for the action-loop scan. */
const W = 8;
/** Edits of one file path that constitute edit churn. */
const E = 6;
/** Consecutive steps with no new file path that constitute spinning. */
const K = 10;

/** The normalized file path an event touches, or `null` if it is not a path event. */
function filePath(event: TrajectoryEvent): string | null {
  const sig = signature(event);
  return sig.kind === "path" ? sig.key : null;
}

/** ACTION LOOP: a non-recon signature repeats ≥ L times inside a window of W. */
function detectActionLoop(events: TrajectoryEvent[]): Finding | null {
  for (let start = 0; start < events.length; start++) {
    const window = events.slice(start, start + W);
    if (window.length < L) break; // not enough remaining events to form a loop
    const counts = new Map<string, number>();
    for (const event of window) {
      const sig = signature(event);
      if (sig.kind === "recon") continue;
      const key = signatureKey(sig);
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      if (next >= L) {
        // Report the true number of repeats in this window, not just `L` — we
        // stop scanning once the threshold is met, so finish counting the key.
        const total = window.reduce((n, e) => (signatureKey(signature(e)) === key ? n + 1 : n), 0);
        return {
          severity: "warn",
          message: `action loop: the same call repeats ${total}× within ${W} steps (${sig.tool} ${sig.key})`,
          evidence: { kind: "action", signature: key, count: total, window: W },
        };
      }
    }
  }
  return null;
}

/** STUCK LOOP: the same non-zero exit code ≥ L times consecutively. */
function detectStuckLoop(events: TrajectoryEvent[]): Finding | null {
  let prev: number | undefined;
  let run = 0;
  for (const event of events) {
    const code = event.exitCode;
    if (code !== undefined && code !== 0 && code === prev) {
      run++;
    } else {
      run = code !== undefined && code !== 0 ? 1 : 0;
    }
    prev = code;
    if (run >= L) {
      return {
        severity: "warn",
        message: `stuck loop: exit code ${code} repeated ${run}× in a row`,
        evidence: { kind: "stuck", exitCode: code, count: run },
      };
    }
  }
  return null;
}

/** EDIT CHURN: one file path edited ≥ E times total. */
function detectEditChurn(events: TrajectoryEvent[]): Finding | null {
  const counts = new Map<string, number>();
  for (const event of events) {
    const path = filePath(event);
    if (path === null) continue;
    const next = (counts.get(path) ?? 0) + 1;
    counts.set(path, next);
    if (next >= E) {
      return {
        severity: "warn",
        message: `edit churn: ${path} edited ${next}×`,
        path,
        evidence: { kind: "edit-churn", path, count: next },
      };
    }
  }
  return null;
}

/** SPINNING: ≥ K consecutive steps introduce no previously-unseen file path. */
function detectSpinning(events: TrajectoryEvent[]): Finding | null {
  const seen = new Set<string>();
  let run = 0;
  for (const event of events) {
    const path = filePath(event);
    if (path !== null && !seen.has(path)) {
      seen.add(path);
      run = 0; // progress: a new file entered the picture
    } else {
      run++;
      if (run >= K) {
        return {
          severity: "warn",
          message: `spinning: ${run} consecutive steps without touching a new file`,
          evidence: { kind: "spinning", count: run, window: K },
        };
      }
    }
  }
  return null;
}

function run(ctx: CheckContext): CheckResult {
  const events = ctx.trajectory?.events ?? [];
  const hasExitCode = ctx.trajectory?.coverage.hasExitCode ?? false;

  const findings: Finding[] = [];
  const action = detectActionLoop(events);
  if (action) findings.push(action);
  // Per-field degradation: only scan exit codes if the trace actually has any.
  if (hasExitCode) {
    const stuck = detectStuckLoop(events);
    if (stuck) findings.push(stuck);
  }
  const churn = detectEditChurn(events);
  if (churn) findings.push(churn);
  const spinning = detectSpinning(events);
  if (spinning) findings.push(spinning);

  const looping = findings.length > 0;
  return {
    check: "loop-detection",
    status: looping ? "warn" : "pass",
    score: looping ? 0 : 1,
    findings,
  };
}

export const check: Check = {
  id: "loop-detection",
  cls: "trajectory",
  requires: ["trajectory", "contract"],
  run,
};
