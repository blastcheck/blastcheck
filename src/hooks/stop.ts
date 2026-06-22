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
import {
  baselinePath,
  fileHasContent,
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

  // Surfacing + exit code are the reporter's job (default: raw scorecard → stdout,
  // summary → stderr, verdict → exit code). A reporter must degrade quietly, but
  // guard anyway: a surfacing failure must never mask a completed audit.
  try {
    return await reporter.surface({ scorecard, json }, options);
  } catch (err) {
    log("warn", `stop: reporter failed: ${err instanceof Error ? err.message : String(err)}`);
    return scorecard.verdict === "fail" ? EXIT.FAIL : EXIT.OK;
  }
}
