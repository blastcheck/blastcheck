/**
 * Adapter registry (AC6) — maps a `--from` format to a FILE-LEVEL adapter
 * `(rawText) => ExternalTrajectoryEvent[]`. This is the only place that knows the
 * set of supported native formats; the `adapt` CLI command and tests resolve
 * adapters exclusively through here.
 *
 * `claude-code`'s native on-disk shape is the canonical JSONL the hook already
 * writes, so its file-level adapter just parses each line and runs the existing
 * per-event `adaptClaudeCodePostToolUse` over the batch (preserving line order as
 * `step`). The cross-agent adapters parse their native logs directly.
 */

import { adaptAiderHistory } from "./aider.js";
import { adaptClaudeCodePostToolUse } from "./claude-code.js";
import { adaptCodexRollout } from "./codex.js";
import { type ExternalTrajectoryEvent, splitLines, tryParseJson } from "./common.js";
import { adaptCursorStream } from "./cursor.js";

export type TrajectoryFormat = "claude-code" | "codex" | "cursor" | "aider";

/** A file-level adapter: raw native log text → external trajectory events. */
export type TrajectoryAdapter = (rawText: string) => ExternalTrajectoryEvent[];

/** File-level wrapper over the per-event `claude-code` adapter (AC6). */
function adaptClaudeCodeFile(rawText: string): ExternalTrajectoryEvent[] {
  const records = splitLines(rawText)
    .filter((line) => line.trim() !== "")
    .map((line) => tryParseJson(line))
    .filter((value) => value !== undefined);
  // Pass the whole batch so the adapter numbers `step` by line order (1..N).
  return adaptClaudeCodePostToolUse(records);
}

const ADAPTERS: Record<TrajectoryFormat, TrajectoryAdapter> = {
  "claude-code": adaptClaudeCodeFile,
  codex: adaptCodexRollout,
  cursor: adaptCursorStream,
  aider: adaptAiderHistory,
};

/** The supported `--from` formats, for help text and validation messages. */
export const TRAJECTORY_FORMATS = Object.keys(ADAPTERS) as TrajectoryFormat[];

/** Narrow an arbitrary string to a known {@link TrajectoryFormat}. */
export function isTrajectoryFormat(value: string): value is TrajectoryFormat {
  return Object.hasOwn(ADAPTERS, value);
}

/** Resolve the file-level adapter for a (validated) format. */
export function getAdapter(format: TrajectoryFormat): TrajectoryAdapter {
  return ADAPTERS[format];
}
