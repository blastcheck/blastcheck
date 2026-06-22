/**
 * OpenCode reporter (brief §5 / step 4) — the OpenCode counterpart of the Claude
 * Code (`claude-code.ts`) and Codex (`codex.ts`) reporters.
 *
 * OpenCode is structurally different from Claude Code / Codex, and that drives
 * this reporter's shape (see Story 1.3 "process-boundary" notes):
 *
 *  - The visible surfacing primitives — a TUI toast (`client.tui.showToast`) and
 *    feedback injection (`client.session.prompt`) — live on the typed SDK
 *    `client`, which exists ONLY inside the plugin's Bun runtime
 *    (`OPENCODE_PLUGIN_SOURCE`). The audit, however, runs in a SEPARATE process —
 *    `blastcheck hook opencode stop` (this Node CLI) — which has no `client` and
 *    therefore cannot render a toast or send a prompt itself.
 *  - So this reporter can only DESCRIBE the surfacing: it emits a single surface
 *    JSON line — `{ message, variant, feedback? }` — to stdout. The plugin's
 *    `session.idle` handler captures that line and performs the `client`-dependent
 *    side effects (toast always; prompt when `feedback` is present). All wording,
 *    variant mapping, and option-gating stay here in tested TypeScript; the plugin
 *    is a thin render shim.
 *  - The `fail` desktop alert is the exception: it is a plain `osascript` /
 *    `notify-send` shell-out with no `client` dependency, so the CLI fires it here
 *    directly via the shared `desktopAlert` helper (consistent with how
 *    `runCodexNotify` fires it).
 *
 * `message` carries `verdictHeadline` on EVERY verdict including `pass` (Slava's
 * §7.1 "show a brief all-clear" call). `feedback` carries `verdictDetail` only on
 * a warn/fail when the opt-in `feedback` option is on (§7.2). `block` is NOT
 * implemented for OpenCode v1 (§7.3 block is OFF; OpenCode's hard-block idiom is a
 * `throw` in `tool.execute.before`, which does not apply at `session.idle`), so
 * `options.block` is a no-op here — the deferred CI-opt-in hook mirrors the
 * Claude/Codex stance.
 *
 * The scorecard itself is NOT written to stdout — it stays the
 * `.blastcheck/scorecard.json` mirror `runStop` already wrote (source of truth,
 * §4.3), so stdout carries only the surface line and the plugin can parse it
 * cleanly (`log()` goes to stderr only). Exit code is ALWAYS 0: the verdict rides
 * in the surface JSON + the scorecard mirror, never the exit status.
 */

import { EXIT } from "../types.js";
import { desktopAlert } from "./desktop-alert.js";
import type { ReportContext, Reporter, SurfacingOptions } from "./types.js";
import { verdictDetail, verdictHeadline } from "./verdict-text.js";

/** The native-idiom surface payload the plugin renders (exported for tests). */
export interface OpencodeSurface {
  /** The visible toast body — `verdictHeadline`, shown on every verdict. */
  message: string;
  /** Toast variant; maps the verdict to the OpenCode `tui.showToast` enum. */
  variant: string;
  /** Opt-in feedback to inject via `client.session.prompt` (warn/fail only). */
  feedback?: string;
}

/**
 * Verdict → OpenCode toast variant. Source-derived from the SDK `tui.showToast`
 * `variant` union (`"info" | "success" | "warning" | "error"`, verified
 * 2026-06-23 against packages/sdk/js/src/gen/types.gen.ts). Variant is cosmetic —
 * the toast must still render, so this never throws on an unexpected verdict.
 */
const VERDICT_VARIANT: Record<ReportContext["scorecard"]["verdict"], string> = {
  pass: "success",
  warn: "warning",
  fail: "error",
};

/** The surface payload the plugin renders for this scorecard (exported for tests). */
export function buildOpencodeSurface(
  ctx: ReportContext,
  options: SurfacingOptions,
): OpencodeSurface {
  const { scorecard } = ctx;
  const surface: OpencodeSurface = {
    message: verdictHeadline(scorecard),
    variant: VERDICT_VARIANT[scorecard.verdict] ?? "info",
  };

  // Opt-in feedback (§7.2): only a warn/fail carries detail back into the
  // session, and only when `feedback` is enabled. Pass stays a bare toast.
  // `block` (§7.3) is deliberately a no-op for OpenCode v1 — its hard-block idiom
  // (`throw` in `tool.execute.before`) does not apply at `session.idle`; the
  // CI-opt-in hook is deferred, mirroring the Claude/Codex reporters.
  if (options.feedback && scorecard.verdict !== "pass") {
    surface.feedback = verdictDetail(scorecard);
  }

  return surface;
}

export const opencodeReporter: Reporter = {
  surface(ctx: ReportContext, options: SurfacingOptions) {
    const surface = buildOpencodeSurface(ctx, options);
    // stdout carries ONLY the surface line (the scorecard mirror is the source of
    // truth, §4.3) so the plugin can parse the last non-empty line cleanly.
    process.stdout.write(`${JSON.stringify(surface)}\n`);

    // `fail` desktop alert (§7.1: alert on fail only). Unlike the toast/feedback,
    // this channel needs no `client` — it is a shell-out — so the CLI fires it
    // directly via the shared helper. Reuse the already-built `message` (it IS
    // `verdictHeadline`) so a partial scorecard can't throw on a re-render.
    if (ctx.scorecard.verdict === "fail") desktopAlert(surface.message);

    // Verdict rides in the surface JSON + the scorecard mirror, never the exit
    // code: the plugin shells `.nothrow()` and discards it, and a clean OK avoids
    // any "hook failed" semantics.
    return EXIT.OK;
  },
};
