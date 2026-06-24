/**
 * `blastcheck hook session-start` — records the pre-commitment reference (AC4).
 *
 * Fires from Claude Code's `SessionStart` event. It captures the current HEAD as
 * `start_head` — the point BEFORE the agent does anything — so `post-tool-use`
 * can later recognize the session's first commit and pin it as the audit
 * baseline. On a brand-new session (`startup`/`clear`) it also resets the
 * trajectory, any stale baseline, and the `last-surfaced` dedup marker (Story
 * 1.1) so the first Stop of a fresh session surfaces; on a continued source (`resume`, and
 * Codex's `compact`) it leaves accumulated state intact so the session keeps its
 * trajectory and baseline. `FRESH_SOURCES` lists ONLY the reset sources, so any
 * other source — including Codex `compact`, which Claude Code does not emit — is
 * correctly treated as a continuation (a compacted session is the same session;
 * resetting would discard its evidence). [AC7]
 *
 * Never throws — a hook must not crash the session (consistency rule #6).
 */

import { log } from "../log.js";
import { currentHead } from "./git.js";
import {
  baselinePath,
  clearFile,
  lastSurfacedPath,
  removeFile,
  startHeadPath,
  trajectoryPath,
  writeStateFile,
} from "./state.js";

/** Sources that begin a fresh session and should reset accumulated state. */
const FRESH_SOURCES = new Set(["startup", "clear"]);

export async function runSessionStart(
  payload: Record<string, unknown> | undefined,
  cwd: string,
): Promise<void> {
  try {
    const source = typeof payload?.source === "string" ? payload.source : "startup";

    if (FRESH_SOURCES.has(source)) {
      // A new session: drop the previous session's trajectory, baseline, and
      // last-surfaced marker so the upcoming audit reflects only this run and the
      // first Stop surfaces rather than being deduped against a stale marker.
      await clearFile(trajectoryPath(cwd));
      await removeFile(baselinePath(cwd));
      await removeFile(lastSurfacedPath(cwd));
    }

    const head = await currentHead(cwd);
    if (head !== undefined) {
      await writeStateFile(startHeadPath(cwd), head);
      log("debug", `session-start: start_head=${head} (source=${source})`);
    } else {
      // HEAD is unreadable for two distinct reasons — no git repo, or a repo with
      // no commits yet (unborn HEAD). Don't assert "no git repo": pinning is simply
      // disabled until a commit exists.
      log(
        "info",
        "session-start: HEAD unavailable (no repo or no commits yet) — pre-commitment pinning disabled",
      );
    }
  } catch (err) {
    // Degrade quietly: a failed hook must never block the session.
    log("warn", `session-start hook failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
