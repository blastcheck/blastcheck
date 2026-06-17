/**
 * Check `extraneous-tool-calls` — tool-budget & redundancy (FR8). Class:
 * trajectory. Produces a `score` (`toolEfficiency`); it is NOT a gate.
 *
 * From `ctx.trajectory.events`:
 *  - `toolCallsTotal = events.length` (recon calls INCLUDED).
 *  - per-`tool` histogram.
 *  - `overBudget = max(0, total − budget.maxToolCalls)`.
 *  - `redundantCalls` = repeated identical signatures, counting NON-recon events
 *    only — recon (`git status`/`ls`/`pwd`/`cat`) is free orientation, never
 *    "redundant", but still counts toward `total`.
 *  - `score = toolEfficiency = clamp(1 − (overBudget + redundantCalls) / total, 0, 1)`.
 *
 * Metrics ride in ONE info-`Finding.evidence` so the `scorecard.json` `stats`
 * shape (git-only, `.strict()`) is NOT changed (story 2.2 decision). `status` is
 * always `pass` — the warn/fail threshold for `toolEfficiency` is applied by the
 * verdict engine, never here.
 */

import { signature, signatureKey } from "../match/signature.js";
import type { Check, CheckContext, CheckResult, Finding } from "../types.js";

function clamp(value: number, lo: number, hi: number): number {
  // Math.min/Math.max propagate NaN, so a non-finite score (e.g. degenerate
  // budget.maxToolCalls) would leak through; floor it to `lo` instead.
  if (!Number.isFinite(value)) return lo;
  return Math.max(lo, Math.min(hi, value));
}

function run(ctx: CheckContext): CheckResult {
  const events = ctx.trajectory?.events ?? [];
  const total = events.length;

  // `requires: ['trajectory']` guarantees ≥1 usable event, but a defensive guard
  // keeps the score finite if that ever changes (degradation over a NaN).
  if (total === 0) {
    return {
      check: "extraneous-tool-calls",
      status: "pass",
      score: 1,
      findings: [],
    };
  }

  const histogram: Record<string, number> = {};
  const distinctNonRecon = new Set<string>();
  let nonReconTotal = 0;

  for (const event of events) {
    histogram[event.tool] = (histogram[event.tool] ?? 0) + 1;
    const sig = signature(event);
    if (sig.kind === "recon") continue;
    nonReconTotal++;
    distinctNonRecon.add(signatureKey(sig));
  }

  const overBudget = Math.max(0, total - ctx.contract.budget.maxToolCalls);
  const redundantCalls = nonReconTotal - distinctNonRecon.size;
  const toolEfficiency = clamp(1 - (overBudget + redundantCalls) / total, 0, 1);

  const findings: Finding[] = [
    {
      severity: "info",
      message: `${total} tool calls, ${overBudget} over budget, ${redundantCalls} redundant`,
      evidence: {
        tool_calls_total: total,
        histogram,
        over_budget: overBudget,
        redundant_calls: redundantCalls,
      },
    },
  ];

  return { check: "extraneous-tool-calls", status: "pass", score: toolEfficiency, findings };
}

export const check: Check = {
  id: "extraneous-tool-calls",
  cls: "trajectory",
  requires: ["trajectory", "contract"],
  run,
};
