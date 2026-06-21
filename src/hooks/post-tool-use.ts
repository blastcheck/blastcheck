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
import { adaptCodexPostToolUse } from "../trajectory/adapters/codex-lifecycle.js";
import type { ExternalTrajectoryEvent } from "../trajectory/adapters/common.js";
import { currentHead } from "./git.js";
import {
  appendLine,
  baselinePath,
  readStateFile,
  startHeadPath,
  trajectoryPath,
  writeStateFile,
} from "./state.js";

/**
 * Normalizes a raw hook payload into canonical events. The record+pin handler is
 * agent-agnostic; the adapter is the ONLY agent-specific seam, so it is injected
 * (Claude default below, Codex via {@link runCodexPostToolUse}) — one
 * implementation, two callers (mirrors Story 2.1's shared installer-merge).
 */
type PostToolUseAdapter = (input: unknown) => ExternalTrajectoryEvent[];

export async function runPostToolUse(
  payload: unknown,
  cwd: string,
  adapt: PostToolUseAdapter = adaptClaudeCodePostToolUse,
): Promise<void> {
  try {
    await recordEvents(payload, cwd, adapt);
  } catch (err) {
    log("warn", `post-tool-use record failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    await pinBaseline(cwd);
  } catch (err) {
    log("warn", `post-tool-use pin failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Codex `PostToolUse` handler — identical record+pin as Claude, only the adapter
 * differs (Codex lifecycle payload → canonical events). The baseline-pin logic is
 * reused unchanged: Codex shares the canonical `.blastcheck/` evidence (FR23).
 */
export async function runCodexPostToolUse(payload: unknown, cwd: string): Promise<void> {
  return runPostToolUse(payload, cwd, adaptCodexPostToolUse);
}

/**
 * OpenCode `PostToolUse` handler. Unlike Codex it injects NO custom adapter: the
 * generated OpenCode plugin pre-shapes each `tool.execute.after` event into the
 * Claude-compatible `{ tool_name, tool_input, tool_response }` payload before it
 * reaches stdin, so the DEFAULT `adaptClaudeCodePostToolUse` already normalizes
 * it to a canonical line (FR38) — no `src/trajectory/` OpenCode adapter is needed
 * here (FR35's dedicated adapter stays conditional, owned by Story 3.3). Sharing
 * the record+pin path keeps the canonical `.blastcheck/` evidence agent-agnostic
 * (FR23/FR51).
 */
export async function runOpencodePostToolUse(payload: unknown, cwd: string): Promise<void> {
  return runPostToolUse(payload, cwd);
}

async function recordEvents(
  payload: unknown,
  cwd: string,
  adapt: PostToolUseAdapter,
): Promise<void> {
  const events = adapt(payload);
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
