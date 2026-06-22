/**
 * Reporter (egress) abstraction — symmetric to the input adapters (brief §8).
 *
 * The input side normalizes many agent trace formats DOWN to one canonical
 * trajectory. The output side does the inverse: the core computes ONE scorecard,
 * and a per-agent {@link Reporter} translates it UP into that agent's native
 * idiom (Claude Code hook JSON, Codex `statusMessage`/exit-2, an OpenCode TUI
 * toast). The core never learns the per-agent differences — it hands the reporter
 * a finished scorecard and the reporter speaks the local dialect.
 *
 * Invariants this layer must preserve (brief §4):
 *  - `.blastcheck/scorecard.json` stays the source of truth — `runStop` writes it
 *    BEFORE any reporter runs; a reporter is a surfacing overlay, never a store.
 *  - Passive: a reporter may show / notify / feed text back, but the hard block is
 *    OFF unless `block` is explicitly enabled (§7.3).
 *  - Quiet on pass is RELAXED per Slava's §7.1 call: pass surfaces ONE brief
 *    "all clear" line (no alert, no feedback) — a positive confirmation, not noise.
 *  - Degrade quietly: an unavailable channel is a no-op, never a throw (§9 step 2).
 */

import type { Scorecard } from "../scorecard/schema.js";
import type { ExitCode } from "../types.js";

/**
 * Opt-in surfacing behaviors (brief §7.2 / §7.3), both default OFF. Sourced from
 * the `.blastcheck.yml` `surfacing:` block and/or env vars (see `options.ts`).
 */
export interface SurfacingOptions {
  /** §7.2: feed the verdict back into the agent's context. Opt-in. */
  feedback: boolean;
  /** §7.3: hard-block a `fail` verdict. Opt-in (CI-style gating). */
  block: boolean;
}

/** Safe default: passive surfacing — show only, never feed back or block. */
export const DEFAULT_SURFACING: SurfacingOptions = { feedback: false, block: false };

/** What a reporter receives: the finished scorecard plus its serialized form. */
export interface ReportContext {
  scorecard: Scorecard;
  /** The pretty-printed scorecard JSON `runStop` already serialized + mirrored. */
  json: string;
}

/**
 * Translates a finished scorecard into one agent's end-of-turn surfacing, and
 * returns the process exit code the hook should use. Returning the exit code
 * (rather than letting `runStop` derive it from the verdict) lets a reporter map
 * a `fail` to a CLEAN visible line on exit 0 — instead of the ugly "hook failed"
 * an exit 1 produces in an agent's hook engine — and reserve non-zero strictly
 * for an explicit `block`.
 */
export interface Reporter {
  surface(ctx: ReportContext, options: SurfacingOptions): ExitCode | Promise<ExitCode>;
}
