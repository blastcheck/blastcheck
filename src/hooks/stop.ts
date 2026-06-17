/**
 * `blastcheck hook stop` — runs the audit at session end (AC3).
 *
 * Fires from Claude Code's `Stop` event. It mirrors `blastcheck run` exactly,
 * through the SAME `runAudit()` entry point (AR9): `scorecard.json` → stdout
 * (NFR9), the human summary → stderr, and the exit code follows the verdict
 * (`fail` → 1, otherwise 0; a tool error → 2, NFR10). The scorecard is also
 * mirrored to `.blastcheck/scorecard.json` for convenience.
 *
 * Loop guard: when Claude Code is already continuing because of a previous
 * blocking Stop hook (`stop_hook_active === true`), this returns immediately
 * without re-auditing.
 */

import { runAudit } from "../index.js";
import { log } from "../log.js";
import { printScorecard } from "../scorecard/print.js";
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

  // stdout: the machine contract, and nothing else (NFR9).
  const json = `${JSON.stringify(scorecard, null, 2)}\n`;
  process.stdout.write(json);
  // stderr: the human-readable summary.
  printScorecard(scorecard);

  // Side mirror; a write failure must not change the verdict's exit code.
  try {
    await writeStateFile(scorecardPath(cwd), json);
  } catch (err) {
    log(
      "warn",
      `stop: failed to mirror scorecard: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return scorecard.verdict === "fail" ? EXIT.FAIL : EXIT.OK;
}
