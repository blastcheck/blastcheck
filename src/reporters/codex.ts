/**
 * Codex reporter (brief §5 / step 4) — the Codex counterpart of the Claude Code
 * reporter (`claude-code.ts`), structurally identical minus the desktop alert.
 *
 * A Codex `Stop` command hook's stdout is consumed by Codex's hook engine as
 * control JSON (verified 2026-06-22 against https://developers.openai.com/codex/hooks),
 * and the output schema is near-identical to Claude Code's:
 *
 *  - `systemMessage` — the visible verdict line, shown on EVERY verdict including
 *    pass (Slava's §7.1 "show a brief all-clear" call). This is the SAME field
 *    Claude Code uses — NOT the brief's §5 `statusMessage`, which is a hook-
 *    DEFINITION config label shown *while* the hook runs, not a per-verdict
 *    output. We never emit `statusMessage` (it would also change the hook's trust
 *    hash → force a re-`/hooks`-trust for no gain, AC8).
 *  - `hookSpecificOutput.additionalContext` — feeds the verdict back to Codex on
 *    warn/fail when `feedback` is enabled (opt-in, §7.2).
 *  - `decision: "block"` + `reason` — turns a `fail` into a continuation prompt
 *    when `block` is enabled (opt-in, §7.3). Default off, so a normal session is
 *    never blocked.
 *
 * There is NO alert/terminal-sequence output field on Codex (unlike Claude's
 * `terminalSequence`). The `fail` desktop alert therefore does NOT ride this
 * output — it travels through the user-level `notify` program instead (FR2; see
 * `blastcheck notify codex` + `desktop-alert.ts`).
 *
 * Exit code is ALWAYS 0: the verdict is carried by `systemMessage`/`decision`,
 * never the exit status (a non-zero Codex hook renders as an ugly "hook failed").
 * Codex also documents an exit-2 + stderr continuation channel, but we
 * deliberately use the exit-0 JSON path to mirror the Claude reporter (Dev Notes
 * "Feedback/block channel decision"). The scorecard itself is NOT written to
 * stdout here — it stays the `.blastcheck/scorecard.json` mirror `runStop`
 * already wrote (source of truth, §4.3). stderr is left clean.
 */

import { EXIT } from "../types.js";
import type { ReportContext, Reporter, SurfacingOptions } from "./types.js";
import { verdictDetail, verdictHeadline } from "./verdict-text.js";

/** The exact JSON a Codex `Stop` hook emits for this scorecard (exported for tests). */
export function buildCodexStopOutput(
  ctx: ReportContext,
  options: SurfacingOptions,
): Record<string, unknown> {
  const { scorecard } = ctx;
  const headline = verdictHeadline(scorecard);
  const out: Record<string, unknown> = { systemMessage: headline };

  if (scorecard.verdict === "pass") return out; // brief positive line only — no alert/feedback

  // No `terminalSequence`/alert field: Codex Stop output has no alert primitive,
  // so the `fail` desktop alert is decoupled into the user-level `notify` program.

  // `block` only ever applies to a fail (warn never blocks, spec §4). When it
  // does, `decision: "block"` already feeds `reason` back to Codex and forces a
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

export const codexReporter: Reporter = {
  surface(ctx: ReportContext, options: SurfacingOptions) {
    const out = buildCodexStopOutput(ctx, options);
    process.stdout.write(`${JSON.stringify(out)}\n`);
    // Verdict rides in `systemMessage`/`decision`, never the exit code.
    return EXIT.OK;
  },
};
