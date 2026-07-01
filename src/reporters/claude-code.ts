/**
 * Claude Code reporter (brief §5 / step 4).
 *
 * A Claude Code `Stop` command hook's stdout is consumed by Claude Code's hook
 * engine as control JSON — NOT piped anywhere a human or CI reads. So the raw
 * scorecard on stdout (the old behavior) is silently swallowed: it parses as JSON
 * but carries no recognized control field, so nothing surfaces. That is exactly
 * why the verdict was invisible. This reporter emits the native hook JSON plus one
 * OS-level side channel:
 *
 *  - `systemMessage` — the single visible verdict line, shown on EVERY verdict
 *    including pass and fail (D6 single channel: a fail surfaces here too, never via
 *    a model-mediated `decision:"block"` continuation). blastcheck registers via
 *    `.claude/settings.json` (NOT a plugin), so the issue #50542 plugin-render
 *    regression does not apply. **However:** whether Claude Code's own chat UI
 *    renders this string as anything visible is a SEPARATE, unverified question from
 *    whether the engine accepts it (see `_bmad-output/implementation-artifacts/
 *    1-1-spike-systemmessage-stop-contract.md`, "Post-Merge Verification", 2026-07-01):
 *    the engine reliably records a `hook_system_message` attachment on every sampled
 *    version/entrypoint, but on `entrypoint: claude-desktop` that attachment was
 *    empirically confirmed to produce NO visible line, 3/3 live turns. Do not repeat
 *    the old "verified against v2.1.191" claim — that was never re-checked against
 *    a live GUI turn and turned out to be false for at least one client.
 *  - `terminalSequence` — a BEL + OSC 9 escape, emitted only on a **gate-driven**
 *    fail (FR3/NFR5: a score-driven fail stays calm, same as a warn). This rides the
 *    same hook-JSON contract as `systemMessage`, so it inherits the identical
 *    unverified-render risk — it is NOT a proven independent floor, just a second
 *    field on the same channel.
 *  - `desktopAlert(...)` (from `./desktop-alert.js`) — a genuine OS-level
 *    notification (`osascript`/`notify-send`), fired directly by THIS process as a
 *    side effect in `surface()`, independent of anything Claude Code's engine or UI
 *    does with the hook JSON. Fires on every non-`pass` verdict (`warn` and `fail`
 *    alike — deliberately NOT gated to gate-fail the way `terminalSequence` is): the
 *    render-gap finding above showed a `claude-desktop` warn produces literally no
 *    signal on the JSON-contract channels, so `warn` needs a real fallback too, not
 *    just `fail`. This is the actual render-independent floor (it doesn't touch
 *    Claude Code's hook JSON at all); `systemMessage`/`terminalSequence` are kept for
 *    clients where they do render (and for the copy-pasteable line in the transcript).
 *    Best-effort/quiet-degrading like the Codex path — see `desktop-alert.ts`.
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
 * §4.3, and the durable degradation floor below every surfacing channel above).
 * stderr is left clean: on exit 0 Claude Code hides hook stderr, so a
 * summary there would only be transcript noise.
 */

import { EXIT } from "../types.js";
import { desktopAlert } from "./desktop-alert.js";
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
    // The one channel that does not depend on Claude Code's own render of the hook
    // JSON (see file header): fires on `warn` too, not just a gate-fail, because the
    // render-gap finding showed `warn` needs a real fallback on `claude-desktop` just
    // as much as `fail` does. `desktopAlert` degrades quietly on its own (no try/catch
    // needed here).
    if (ctx.scorecard.verdict !== "pass") desktopAlert(verdictHeadline(ctx.scorecard));
    // Verdict rides in `systemMessage`, never the exit code.
    return EXIT.OK;
  },
};
