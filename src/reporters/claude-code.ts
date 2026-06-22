/**
 * Claude Code reporter (brief §5 / step 4).
 *
 * A Claude Code `Stop` command hook's stdout is consumed by Claude Code's hook
 * engine as control JSON — NOT piped anywhere a human or CI reads. So the raw
 * scorecard on stdout (the old behavior) is silently swallowed: it parses as JSON
 * but carries no recognized control field, so nothing surfaces. That is exactly
 * why the verdict was invisible. This reporter instead emits the native hook JSON:
 *
 *  - `systemMessage` — the visible verdict line, shown on every verdict including
 *    pass (Slava's §7.1 "show a brief all-clear" call). blastcheck registers via
 *    `.claude/settings.json` (NOT a plugin), so the issue #50542 plugin-render
 *    regression does not apply and `systemMessage` renders. Verified channel
 *    against Claude Code v2.1.185.
 *  - `terminalSequence` — a desktop alert (BEL + OSC 9) on `fail` ONLY (§7.1:
 *    alert only on fail). Both sequences are on Claude Code's allowlist and need
 *    v2.1.141+. Plugin-safe, so it also doubles as the fail backstop if a future
 *    version regresses `systemMessage`.
 *  - `hookSpecificOutput.additionalContext` — feeds the verdict back to Claude on
 *    warn/fail when `feedback` is enabled (opt-in, §7.2; needs v2.1.163+).
 *  - `decision: "block"` + `reason` — hard-blocks a `fail` when `block` is enabled
 *    (opt-in, §7.3). Default off, so a normal session is never blocked.
 *
 * Exit code is ALWAYS 0: the verdict is carried by `systemMessage`, not the exit
 * status. (The old path exited 1 on `fail`, which Claude Code renders as an ugly
 * "hook failed" error rather than a clean verdict line.) The hard block travels
 * via `decision: "block"`, also on exit 0 — never via a non-zero exit, which the
 * engine would mis-read as a tool error.
 *
 * The scorecard itself is NOT written to stdout here — it stays the
 * `.blastcheck/scorecard.json` mirror `runStop` already wrote (source of truth,
 * §4.3). stderr is left clean: on exit 0 Claude Code hides hook stderr, so a
 * summary there would only be transcript noise.
 */

import { EXIT } from "../types.js";
import type { ReportContext, Reporter, SurfacingOptions } from "./types.js";
import { verdictDetail, verdictHeadline } from "./verdict-text.js";

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
  const out: Record<string, unknown> = { systemMessage: headline };

  if (scorecard.verdict === "pass") return out; // brief positive line only — no alert/feedback

  if (scorecard.verdict === "fail") out.terminalSequence = failAlert(headline);

  // `block` only ever applies to a fail (warn never blocks, spec §4). When it
  // does, `decision: "block"` already feeds `reason` back to Claude and forces a
  // continuation, so it subsumes the feedback channel — don't also set
  // additionalContext (the engine would receive the verdict twice).
  if (options.block && scorecard.verdict === "fail") {
    out.decision = "block";
    out.reason = verdictDetail(scorecard);
  } else if (options.feedback) {
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
    // Verdict rides in `systemMessage`/`decision`, never the exit code.
    return EXIT.OK;
  },
};
