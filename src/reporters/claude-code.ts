/**
 * Claude Code reporter (brief §5 / step 4).
 *
 * A Claude Code `Stop` command hook's stdout is consumed by Claude Code's hook
 * engine as control JSON — NOT piped anywhere a human or CI reads. So the raw
 * scorecard on stdout (the old behavior) is silently swallowed: it parses as JSON
 * but carries no recognized control field, so nothing surfaces. That is exactly
 * why the verdict was invisible. This reporter instead emits the native hook JSON,
 * through a single visible channel plus two degradation layers:
 *
 *  - `systemMessage` — the single visible verdict line, shown on EVERY verdict
 *    including pass and fail (D6 single channel: a fail surfaces here too, never via
 *    a model-mediated `decision:"block"` continuation). blastcheck registers via
 *    `.claude/settings.json` (NOT a plugin), so the issue #50542 plugin-render
 *    regression does not apply and `systemMessage` renders. Verified channel
 *    against Claude Code v2.1.191.
 *  - `terminalSequence` — a desktop alert (BEL + OSC 9) on a fail **from a gate**
 *    only (FR3/NFR5: a score-driven fail stays calm and silent at this channel,
 *    same as a warn — raw thresholds are uncalibrated). Both sequences are on
 *    Claude Code's allowlist and need v2.1.141+. It is the gate-fail visibility
 *    chain's RENDER-INDEPENDENT FLOOR: the one channel that does not depend on
 *    transcript render, so it survives exactly the regressed-version case where
 *    `systemMessage` may not surface. This OS-level toast is a legitimate degradation
 *    layer below the visible line (systemMessage → terminalSequence → scorecard.json
 *    + exit), NOT a redundant nudge. Delivery is best-effort: a headless CI / no-notification host
 *    silently drops it — there, the red exit/check is the floor instead.
 *  - `hookSpecificOutput.additionalContext` — feeds the verdict back to Claude on
 *    warn / score-fail when `feedback` is enabled (opt-in, §7.2; needs v2.1.163+).
 *    A GATE-fail deliberately SUPPRESSES this even with `feedback` on: agent-controlled
 *    finding text must never be injected back into the model (NFR-N2 injection boundary).
 *
 * Exit code is ALWAYS 0: the verdict is carried by `systemMessage`, not the exit
 * status. (The old path exited 1 on `fail`, which Claude Code renders as an ugly
 * "hook failed" error rather than a clean verdict line.) No verdict ever rides a
 * non-zero exit, which the engine would mis-read as a tool error.
 *
 * The scorecard itself is NOT written to stdout here — it stays the
 * `.blastcheck/scorecard.json` mirror `runStop` already wrote (source of truth,
 * §4.3, and the durable degradation floor below `systemMessage`/`terminalSequence`).
 * stderr is left clean: on exit 0 Claude Code hides hook stderr, so a
 * summary there would only be transcript noise.
 */

import { EXIT } from "../types.js";
import type { ReportContext, Reporter, SurfacingOptions } from "./types.js";
import { isGateFail, verdictDetail, verdictHeadline, verdictSubline } from "./verdict-text.js";

/** Bare-bones desktop alert: terminal bell + an OSC 9 notification (allowlisted). */
function failAlert(headline: string): string {
  return `]9;${headline}`;
}

/** The exact JSON a Claude Code `Stop` hook emits for this scorecard (exported for tests). */
export function buildClaudeCodeStopOutput(
  ctx: ReportContext,
  options: SurfacingOptions,
): Record<string, unknown> {
  const { scorecard } = ctx;
  const headline = verdictHeadline(scorecard);
  const subline = verdictSubline(scorecard);
  const out: Record<string, unknown> = {
    systemMessage: subline === undefined ? headline : `${headline}\n${subline}`,
  };

  if (scorecard.verdict === "pass") return out; // brief positive line only — no alert/feedback

  // Desktop alert ONLY on a gate-driven fail — `denied-files`/`required-checks`, the
  // deterministic hard gates. A score-driven fail (churn 2×, a sub-floor score, a
  // high-severity finding) leaves `gates` with no `"fail"` entry, so it stays in the calm
  // dense-line tier (NFR5: never speak loudly on a judgment the tool itself flags as
  // uncalibrated).
  //
  // This is the visibility chain's render-INDEPENDENT floor (see file-header note), kept
  // safe by three invariants verified at review: (1) it rides through `runStop`'s dedup —
  // `surface()` is reached only past the FR1/FR2 gates, so the toast fires once per state
  // change, never on a no-op Stop; (2) gate-only via `isGateFail` (no OS nudge on an
  // uncalibrated score-fail, NFR5); (3) the title is `verdictHeadline` — engine number/enum
  // fields only, never agent-controlled `finding.message`/`path` (NFR2 spirit, even though
  // a terminal sequence is not a model-injection channel).
  if (scorecard.verdict === "fail" && isGateFail(scorecard))
    out.terminalSequence = failAlert(headline);

  // Single channel (D6): NO branch sets `decision`/`reason` anymore — both
  // `decision:"block"` paths (opt-in §7.3 and the default gate-fail push) were removed
  // in Story 1.3. Every verdict, including a fail, surfaces only via `systemMessage`
  // (plus the gate-fail `terminalSequence` alert above). `options.block` is now a no-op
  // for the Claude reporter — it stays plumbed only because Codex still consumes it.
  //
  // The feedback opt-in carries the INJECTION BOUNDARY the removed push used to enforce:
  // the `!(fail && isGateFail)` guard mirrors the exact condition of that push, so a
  // gate-fail with `feedback` ON still emits NO `additionalContext`. The agent-controlled
  // `finding.message`/`path` (in `verdictDetail`) must never be injected back into the
  // model on a gate breach (NFR-N2); on a gate-fail those findings live ONLY in the
  // human-direct `.blastcheck/scorecard.json` mirror. Do NOT "simplify" this guard away —
  // dropping it silently reopens that injection surface. `warn` / score-fail are
  // unaffected (the guard is false for them) and still emit `additionalContext`.
  if (options.feedback && !(scorecard.verdict === "fail" && isGateFail(scorecard))) {
    out.hookSpecificOutput = {
      hookEventName: "Stop",
      additionalContext: verdictDetail(scorecard),
    };
  }

  return out;
}

export const claudeCodeReporter: Reporter = {
  surface(ctx: ReportContext, options: SurfacingOptions) {
    const out = buildClaudeCodeStopOutput(ctx, options);
    process.stdout.write(`${JSON.stringify(out)}\n`);
    // Verdict rides in `systemMessage`, never the exit code.
    return EXIT.OK;
  },
};
