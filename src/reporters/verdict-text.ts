/**
 * Shared, agent-agnostic rendering of a scorecard into human text — the words a
 * reporter surfaces, independent of HOW each agent shows them. One place to phrase
 * the verdict so Claude's `systemMessage`, Codex's `statusMessage`, and OpenCode's
 * toast all read identically (brief §8: one UX, three idioms).
 */

import type { Scorecard } from "../scorecard/schema.js";
import { HARD_FLOOR_BY_SCORE_ID } from "../scorecard/verdict.js";

/** Verdict → status glyph (matches the stderr summary in `print.ts`). */
const VERDICT_GLYPH: Record<Scorecard["verdict"], string> = {
  pass: "✓",
  warn: "‼",
  fail: "✗",
};

/** Severity buckets rendered high→warn→info (loudest first); zero buckets omitted. */
const SEVERITY_ORDER: Scorecard["findings"][number]["severity"][] = ["high", "warn", "info"];

/** Format a number for display, guarding non-finite (mirrors `print.ts`'s `fmt`). */
function fmt(n: number, digits: number): string {
  return Number.isFinite(n) ? n.toFixed(digits) : "n/a";
}

/**
 * The failing-dimensions segment: failed GATES (`denied-files failed`) plus any
 * score that is below its hard floor (`scope_adherence below floor`), joined by
 * `, `. This is the hard, deterministic signal — what actually tripped — so it
 * leads the headline. Empty when nothing nameable failed (a warn driven only by
 * a below-*threshold* score, whose threshold the scorecard does not carry).
 */
function dimensions(scorecard: Scorecard): string {
  const failedGates = Object.entries(scorecard.gates)
    .filter(([, status]) => status === "fail")
    .map(([id]) => `${id} failed`);
  const subFloorScores = Object.entries(scorecard.scores)
    .filter(([id, v]) => HARD_FLOOR_BY_SCORE_ID[id] !== undefined && v < HARD_FLOOR_BY_SCORE_ID[id])
    .map(([id]) => `${id} below floor`);
  return [...failedGates, ...subFloorScores].join(", ");
}

/**
 * The severity-mix segment: a count per present severity bucket, loudest first
 * (`1 high, 2 warn`). Empty when there are no findings.
 */
function severityMix(scorecard: Scorecard): string {
  const counts: Record<string, number> = {};
  for (const f of scorecard.findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  return SEVERITY_ORDER.map((sev) => ({ sev, n: counts[sev] ?? 0 }))
    .filter(({ n }) => n > 0)
    .map(({ sev, n }) => `${n} ${sev}`)
    .join(", ");
}

/**
 * The scale segment: how much changed, for context — `5 files, churn 12.3%`.
 * Always present on a non-pass verdict (a schema-valid scorecard always has
 * `stats`), so it doubles as the floor of information when no dimension/finding
 * is nameable.
 */
function scale(scorecard: Scorecard): string {
  const { files_changed, churn_pct } = scorecard.stats;
  return `${files_changed} files, churn ${fmt(churn_pct, 1)}%`;
}

/**
 * A concise reason for a warn/fail, leading with WHAT failed and at WHAT scale:
 * failing dimensions (gates + sub-floor scores) · finding severity-mix · git
 * scale, joining the non-empty segments with ` · `. A dense, useful signal —
 * not a bare finding count. Empty string for a pass (the headline says
 * "all clear" instead, and `reason()` is never called for it).
 */
function reason(scorecard: Scorecard): string {
  return [dimensions(scorecard), severityMix(scorecard), scale(scorecard)]
    .filter((segment) => segment !== "")
    .join(" · ");
}

/**
 * Whether a `fail` verdict is gate-driven — some hard gate (`denied-files`,
 * `required-checks`) actually failed, as opposed to a score-driven fail (a
 * sub-floor score, churn 2×, an uncalibrated threshold). Shared by the
 * headline's gate-fail/fail-floor split and `claude-code.ts`'s
 * `terminalSequence` trigger, so the two stay in lockstep by construction.
 */
export function isGateFail(scorecard: Scorecard): boolean {
  return Object.values(scorecard.gates).some((s) => s === "fail");
}

/**
 * The single-line verdict headline every channel leads with, one of five forms:
 *  - clean: `blastcheck: ✓ pass — 3 files changed, scope ok`
 *  - empty: `blastcheck: ✓ pass — no changes this session`
 *  - warn: `blastcheck: ‼ warn — 1 warn · 2 files, churn 1.0%`
 *  - fail-gate: `blastcheck: ✗ FAIL — denied-files failed · 1 high, 2 warn · 5 files, churn 12.3%`
 *  - fail-floor: `blastcheck: fail — scope_adherence below floor`
 * `fail-gate` is upper-cased with a glyph for scannability; fail-floor stays
 * lower-case with no glyph (NFR-N3: a score-driven fail never gets alarm
 * framing). pass/warn stay lower-case (calmer).
 */
export function verdictHeadline(scorecard: Scorecard): string {
  const { verdict } = scorecard;
  if (verdict === "pass") {
    return scorecard.stats.files_changed === 0
      ? `blastcheck: ${VERDICT_GLYPH.pass} pass — no changes this session`
      : `blastcheck: ${VERDICT_GLYPH.pass} pass — ${scorecard.stats.files_changed} files changed, scope ok`;
  }
  if (verdict === "fail" && !isGateFail(scorecard)) {
    return `blastcheck: fail — ${reason(scorecard) || "see scorecard"}`;
  }
  const glyph = VERDICT_GLYPH[verdict];
  const label = verdict === "fail" ? "FAIL" : verdict;
  const why = reason(scorecard) || "see scorecard";
  return `blastcheck: ${glyph} ${label} — ${why}`;
}

/**
 * The optional second line for the Claude-Code-only multi-line `systemMessage`
 * (AC #5): a count-only "not run" note on a `required-checks` warn finding, or
 * a pointer at `blastcheck show` on a gate-driven fail. `undefined` for every
 * other state (pass, fail-floor, or a warn with no `required-checks` finding).
 */
export function verdictSubline(scorecard: Scorecard): string | undefined {
  if (scorecard.verdict === "warn") {
    const count = scorecard.findings.filter(
      (f) => f.check === "required-checks" && f.severity === "warn",
    ).length;
    return count > 0 ? `not run: ${count} checks` : undefined;
  }
  if (scorecard.verdict === "fail" && isGateFail(scorecard)) {
    return "run `blastcheck show` for details";
  }
  return undefined;
}

/**
 * A short multi-line detail block for the FEEDBACK channel (fed back to the agent)
 * and for surfaces with room (an OpenCode prompt). It restates the verdict, the
 * failing gates, each finding, and where to look — enough for an agent to act on,
 * without dumping the whole scorecard. Reads the same data `print.ts` shows a
 * human, shaped for an agent's context.
 */
export function verdictDetail(scorecard: Scorecard): string {
  const lines: string[] = [verdictHeadline(scorecard)];

  const failedGates = Object.entries(scorecard.gates).filter(([, s]) => s === "fail");
  for (const [id] of failedGates) lines.push(`  gate failed: ${id}`);

  for (const f of scorecard.findings) {
    const where = f.path !== undefined ? ` (${f.path})` : "";
    lines.push(`  [${f.severity}] ${f.check}: ${f.message}${where}`);
  }

  lines.push("  full scorecard: .blastcheck/scorecard.json");
  return lines.join("\n");
}
