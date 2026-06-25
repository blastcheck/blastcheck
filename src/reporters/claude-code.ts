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
 *    against Claude Code v2.1.191.
 *  - `terminalSequence` — a desktop alert (BEL + OSC 9) on a fail **from a gate**
 *    only (FR3/NFR5: a score-driven fail stays calm and silent at this channel,
 *    same as a warn — raw thresholds are uncalibrated). Both sequences are on
 *    Claude Code's allowlist and need v2.1.141+. It is the gate-fail visibility
 *    chain's RENDER-INDEPENDENT FLOOR: the one channel that does not depend on
 *    transcript render, so it survives exactly the regressed-version case where
 *    `decision`/`reason` and `systemMessage` may not surface. FR6 enumerates three
 *    channels; this OS-level toast is a legitimate fourth degradation layer below
 *    them (push → systemMessage → terminalSequence → scorecard.json + exit), NOT a
 *    redundant nudge. Delivery is best-effort: a headless CI / no-notification host
 *    silently drops it — there, the red exit/check is the floor instead.
 *  - `hookSpecificOutput.additionalContext` — feeds the verdict back to Claude on
 *    warn/fail when `feedback` is enabled (opt-in, §7.2; needs v2.1.163+).
 *  - `decision: "block"` + `reason` — carries the verdict back to the model on a
 *    fail, in one of two modes: (a) opt-in `block` (§7.3) hard-gates ANY fail with
 *    the full detail block (`verdictDetail`, findings included); (b) the DEFAULT push
 *    on a GATE-fail (Story 1.3) fires regardless of the `block` opt-in, with an
 *    injection-safe verbalize-directive `reason` (`buildPushReason`). The push forces
 *    exactly one continuation that the Story 1.1 dedup then silences, so a real gate
 *    breach is surfaced in Claude's visible reply without anyone opening the scorecard.
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

import type { Scorecard } from "../scorecard/schema.js";
import { EXIT } from "../types.js";
import type { ReportContext, Reporter, SurfacingOptions } from "./types.js";
import { verdictDetail, verdictHeadline } from "./verdict-text.js";

/** Bare-bones desktop alert: terminal bell + an OSC 9 notification (allowlisted). */
function failAlert(headline: string): string {
  return `]9;${headline}`;
}

/** The scorecard mirror path — fixed; single-sourced here, mirrors `verdictDetail`'s path line. */
const SCORECARD_PATH = ".blastcheck/scorecard.json";

/**
 * The push `reason` for a gate-fail: a structured, injection-SAFE slot template.
 *
 * Built ONLY from `verdictHeadline` (failed-gate-ids · severity-mix · scale numbers —
 * all engine number/enum fields, NEVER `finding.message`/`finding.path`) + the fixed
 * scorecard path + a directive for Claude to RENDER the verdict in its visible reply,
 * not the report itself (NFR2, FR5). Do NOT swap in `verdictDetail` here: it embeds
 * per-finding `message`/`path`, which the agent partly controls (it chose the paths,
 * it may have authored `task.md`) — exactly the injection surface AC3 locks out.
 * `verdictDetail` stays the reason for the OPT-IN `block` only (§7.3, a user-accepted
 * CI gate).
 */
function buildPushReason(scorecard: Scorecard): string {
  return [
    verdictHeadline(scorecard),
    `Full scorecard: ${SCORECARD_PATH}`,
    "Verbalize this blastcheck verdict to the user before continuing.",
  ].join("\n");
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

  // Desktop alert ONLY on a gate-driven fail — `denied-files`/`required-checks`, the
  // deterministic hard gates. A score-driven fail (churn 2×, a sub-floor score, a
  // high-severity finding) leaves `gates` with no `"fail"` entry, so it stays in the calm
  // dense-line tier (NFR5: never speak loudly on a judgment the tool itself flags as
  // uncalibrated). The gate-fail itself ALSO drives the default push below (Story 1.3).
  //
  // This is the visibility chain's render-INDEPENDENT floor (see file-header note), kept
  // safe by three invariants verified at review: (1) it rides through `runStop`'s dedup —
  // `surface()` is reached only past the FR1/FR2 gates, so the toast fires once per state
  // change, never on a no-op Stop; (2) gate-only via `isGateFail` (no OS nudge on an
  // uncalibrated score-fail, NFR5); (3) the title is `verdictHeadline` — engine number/enum
  // fields only, never agent-controlled `finding.message`/`path` (NFR2 spirit, even though
  // a terminal sequence is not a model-injection channel).
  const isGateFail = Object.values(scorecard.gates).some((s) => s === "fail");
  if (scorecard.verdict === "fail" && isGateFail) out.terminalSequence = failAlert(headline);

  // Exactly ONE decision/reason path wins below — mutually exclusive and exhaustive
  // over the fail tiers (gate-fail+block, gate-fail default push, score-fail/warn).
  if (options.block && scorecard.verdict === "fail") {
    // §7.3 opt-in hard gate — UNCHANGED. Applies to ANY fail; `reason` is the full
    // detail block (findings included), which the user accepted by opting in. Opt-in
    // wins on a gate-fail too, so it precedes the default push.
    out.decision = "block";
    out.reason = verdictDetail(scorecard);
  } else if (scorecard.verdict === "fail" && isGateFail) {
    // FR5 default push (block OFF, gate-fail only) — the strongest interactive
    // channel. `reason` is the injection-safe verbalize DIRECTIVE (not the report),
    // and the block forces exactly one continuation that the Story 1.1 dedup then
    // silences (NFR1). Exit stays EXIT.OK — the verdict rides the JSON, not the code.
    out.decision = "block";
    out.reason = buildPushReason(scorecard);
    // FR6 secondary: augment `systemMessage` with the scorecard PATH — the durable
    // anchor that survives even if `reason` does not render on a regressed Claude Code
    // version (NFR4).
    out.systemMessage = `${headline} — ${SCORECARD_PATH}`;
    // We deliberately do NOT also set `additionalContext` here — and the reason is the
    // injection boundary, NOT "avoid double-delivery" (that rationale is false on this
    // path: the push `reason` is `buildPushReason`, NOT `verdictDetail`, so nothing is
    // duplicated). `additionalContext` would carry `verdictDetail`, whose raw
    // `finding.message`/`path` are agent-controlled (NFR2 injection surface). On a
    // gate-fail those findings belong ONLY in the human-direct channel — the
    // `.blastcheck/scorecard.json` mirror today, `blastcheck show` (FR7) once it lands —
    // never injected back into the model. The gate-fail headline is self-describing, so
    // the in-context detail loss is minor; a feedback user still gets the full detail via
    // the durable mirror. (Sanitized `verdictDetail` → `additionalContext` is deferred to
    // the post-calibration milestone when score-fails begin to push and a sanitizer must
    // be built anyway — see the story's Deferred section.)
  } else if (options.feedback) {
    // score-fail / warn with feedback opt-in — UNCHANGED calm tier (no push, §7.2).
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
