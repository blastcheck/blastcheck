/**
 * Shared, agent-agnostic rendering of a scorecard into human text — the words a
 * reporter surfaces, independent of HOW each agent shows them. One place to phrase
 * the verdict so Claude's `systemMessage`, Codex's `statusMessage`, and OpenCode's
 * toast all read identically (brief §8: one UX, three idioms).
 */

import type { Scorecard } from "../scorecard/schema.js";

/** Verdict → status glyph (matches the stderr summary in `print.ts`). */
const VERDICT_GLYPH: Record<Scorecard["verdict"], string> = {
  pass: "✓",
  warn: "‼",
  fail: "✗",
};

/** Pluralize a count: `1 finding`, `2 findings`. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * A concise reason for a warn/fail: failing gates first (the hard signal), then a
 * finding count. Empty string for a pass (the headline says "all clear" instead).
 */
function reason(scorecard: Scorecard): string {
  const parts: string[] = [];
  const failedGates = Object.entries(scorecard.gates)
    .filter(([, status]) => status === "fail")
    .map(([id]) => id);
  if (failedGates.length > 0) parts.push(`${failedGates.join(", ")} failed`);
  if (scorecard.findings.length > 0) parts.push(count(scorecard.findings.length, "finding"));
  return parts.join("; ");
}

/**
 * The single-line verdict headline every channel leads with, e.g.
 *  - `blastcheck: ✓ pass — all clear`
 *  - `blastcheck: ‼ warn — 2 findings`
 *  - `blastcheck: ✗ FAIL — scope-adhesion failed; 1 finding`
 * `fail` is upper-cased for scannability; pass/warn stay lower-case (calmer).
 */
export function verdictHeadline(scorecard: Scorecard): string {
  const { verdict } = scorecard;
  const glyph = VERDICT_GLYPH[verdict];
  const label = verdict === "fail" ? "FAIL" : verdict;
  if (verdict === "pass") return `blastcheck: ${glyph} ${label} — all clear`;
  const why = reason(scorecard) || "see scorecard";
  return `blastcheck: ${glyph} ${label} — ${why}`;
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
