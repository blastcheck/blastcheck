/**
 * `blastcheck hook post-tool-use` — records the trajectory and pins the baseline
 * (AC2, AC4).
 *
 * Fires after every tool use. Two jobs:
 *  1. Normalize the raw Claude Code payload through the `claude-code` adapter and
 *     append a single canonical JSONL line that `loadTrajectory()` reads directly
 *     (the loader does NOT call the adapter — normalization happens here, on
 *     write). The `step` field is dropped so the loader derives ordering from
 *     line position; emitting the adapter's per-event `step` would tag every line
 *     `1` and destroy the order.
 *  2. Pre-commitment: the first time HEAD differs from the session's `start_head`
 *     (i.e. the session's first commit landed) and no baseline is recorded yet,
 *     record that HEAD as the audit baseline.
 *
 * Never throws and never writes to stdout (a `PostToolUse` stdout is not shown to
 * the agent and would only pollute the debug channel).
 */

import { log } from "../log.js";
import { adaptClaudeCodePostToolUse } from "../trajectory/adapters/claude-code.js";
import { currentHead } from "./git.js";
import {
  appendLine,
  baselinePath,
  readStateFile,
  startHeadPath,
  trajectoryPath,
  writeStateFile,
} from "./state.js";

export async function runPostToolUse(payload: unknown, cwd: string): Promise<void> {
  try {
    await recordEvents(payload, cwd);
  } catch (err) {
    log("warn", `post-tool-use record failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    await pinBaseline(cwd);
  } catch (err) {
    log("warn", `post-tool-use pin failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function recordEvents(payload: unknown, cwd: string): Promise<void> {
  const events = adaptClaudeCodePostToolUse(payload);
  const path = trajectoryPath(cwd);
  for (const event of events) {
    // Drop `step`: the loader assigns order by line position (a single-event
    // adapter call always yields step 1, which would collide across lines).
    const { step: _step, ...line } = event;
    await appendLine(path, JSON.stringify(line));
  }
}

async function pinBaseline(cwd: string): Promise<void> {
  // Already pinned this session — pre-commitment is recorded once and frozen.
  if ((await readStateFile(baselinePath(cwd))) !== undefined) return;

  const startHead = await readStateFile(startHeadPath(cwd));
  if (startHead === undefined) return; // no session-start reference → cannot pin

  const head = await currentHead(cwd);
  if (head === undefined || head === startHead) return; // no new commit yet

  await writeStateFile(baselinePath(cwd), head);
  log("debug", `post-tool-use: pinned baseline=${head}`);
}
