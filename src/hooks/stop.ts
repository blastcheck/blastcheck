/**
 * `blastcheck hook stop` — runs the audit at session end (AC3).
 *
 * Fires from an agent's end-of-turn event (Claude Code `Stop`, Codex `Stop`,
 * OpenCode `session.idle`). It runs the audit through the SAME `runAudit()` entry
 * point (AR9), then ALWAYS mirrors the scorecard to `.blastcheck/scorecard.json`
 * — the source of truth (brief §4.3) — before handing it to a {@link Reporter}.
 *
 * The reporter owns the surfacing (stdout / stderr / desktop alert) AND the exit
 * code, so each agent can speak its native idiom (brief §8). The default
 * {@link rawReporter} reproduces the pre-surfacing behavior (scorecard → stdout,
 * summary → stderr, `fail` → exit 1) so `runStop(payload, cwd)` and the tests
 * that call it directly are unchanged; the CLI passes the per-agent reporter.
 *
 * Loop guard: when an agent is already continuing because of a previous blocking
 * Stop hook (`stop_hook_active === true`), this returns immediately without
 * re-auditing.
 */

import { runAudit } from "../index.js";
import { log } from "../log.js";
import { rawReporter } from "../reporters/raw.js";
import { DEFAULT_SURFACING, type Reporter, type SurfacingOptions } from "../reporters/types.js";
import { EXIT, type ExitCode } from "../types.js";
import { worktreeSignature } from "./git.js";
import {
  baselinePath,
  fileHasContent,
  lastSurfacedPath,
  readStateFile,
  scorecardPath,
  startHeadPath,
  trajectoryPath,
  writeStateFile,
} from "./state.js";

export async function runStop(
  payload: Record<string, unknown> | undefined,
  cwd: string,
  reporter: Reporter = rawReporter,
  options: SurfacingOptions = DEFAULT_SURFACING,
): Promise<ExitCode> {
  // Avoid an audit loop if a prior Stop hook already asked Claude to continue.
  if (payload?.stop_hook_active === true) {
    log("debug", "stop: stop_hook_active — skipping re-audit");
    return EXIT.OK;
  }

  // Baseline: the pinned first session commit, else the session start HEAD
  // (no commits this session → empty diff, honest degradation, not a failure).
  const baselineSha =
    (await readStateFile(baselinePath(cwd))) ?? (await readStateFile(startHeadPath(cwd)));
  if (baselineSha === undefined) {
    log("error", "stop: no baseline recorded (run `blastcheck init`; no git repo?)");
    return EXIT.TOOL_ERROR;
  }

  const traj = trajectoryPath(cwd);
  const hasTrajectory = await fileHasContent(traj);

  let scorecard: Awaited<ReturnType<typeof runAudit>>;
  try {
    scorecard = await runAudit({
      cwd,
      baselineSha,
      ...(hasTrajectory ? { trajectoryPath: traj } : {}),
    });
  } catch (err) {
    log("error", err instanceof Error ? err.message : String(err));
    return EXIT.TOOL_ERROR;
  }

  const json = `${JSON.stringify(scorecard, null, 2)}\n`;

  // Source of truth FIRST (brief §4.3): mirror the scorecard before any surfacing,
  // so the durable artifact exists even if a reporter channel is unavailable. A
  // write failure must not change the verdict's exit code.
  try {
    await writeStateFile(scorecardPath(cwd), json);
  } catch (err) {
    log(
      "warn",
      `stop: failed to mirror scorecard: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // State-dedup (Story 1.1): keep no-op turns silent so the same verdict is not
  // re-flashed on every Stop, and so the gate-fail block (Story 1.3) fires once
  // per state change. This gate is agent-agnostic and runs AFTER the durable
  // mirror (NFR6) but BEFORE any surfacing. Silence returns EXIT.OK — the
  // "continue silently" code — regardless of verdict; the verdict still lives in
  // scorecard.json. Degrade toward surfacing, never toward false silence.

  // FR2 — empty diff: nothing was changed this turn, so there is nothing to
  // surface. Do not touch the marker (no state was surfaced).
  if (scorecard.stats.files_changed === 0) {
    log("debug", "stop: empty diff (files_changed === 0) — surfacing suppressed");
    return EXIT.OK;
  }

  // FR1 — unchanged state: silence only when we can PROVE the surface is
  // identical to the last surfaced one. A `undefined` signature (git unavailable)
  // is "cannot tell" → surface, never dedup on head_sha alone.
  const signature = await worktreeSignature(cwd, baselineSha);
  // `current` is undefined exactly when the signature is unknown (git down) — so
  // the dedup compare and the marker write below are both naturally skipped, and
  // no `?` sentinel is ever persisted or matched.
  const current = signature === undefined ? undefined : `${scorecard.head_sha}:${signature}`;
  if (current !== undefined) {
    const lastSurfaced = await readStateFile(lastSurfacedPath(cwd));
    if (lastSurfaced === current) {
      log("debug", "stop: unchanged state since last surfaced verdict — surfacing suppressed");
      return EXIT.OK;
    }
  }

  // Surfacing + exit code are the reporter's job (default: raw scorecard → stdout,
  // summary → stderr, verdict → exit code). A reporter must degrade quietly, but
  // guard anyway: a surfacing failure must never mask a completed audit.
  let exitCode: ExitCode;
  try {
    exitCode = await reporter.surface({ scorecard, json }, options);
  } catch (err) {
    log("warn", `stop: reporter failed: ${err instanceof Error ? err.message : String(err)}`);
    // A failed surface must NOT update the marker, so the next turn re-surfaces.
    return scorecard.verdict === "fail" ? EXIT.FAIL : EXIT.OK;
  }

  // Mark this state as surfaced ONLY after a successful surface. Best-effort like
  // the scorecard mirror: a marker-write failure must never change the exit code
  // (it only costs a repeated line next turn — degrade toward surfacing). Skip
  // when the signature is unknown — there is no reliable state to record.
  if (current !== undefined) {
    try {
      await writeStateFile(lastSurfacedPath(cwd), current);
    } catch (err) {
      log(
        "warn",
        `stop: failed to write last-surfaced marker: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return exitCode;
}
