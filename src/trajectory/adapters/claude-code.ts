/**
 * `claude-code` adapter — the reference adapter and shape of the external
 * contract. A pure function that normalizes a Claude Code `PostToolUse` payload
 * (one event or an array) into {@link ExternalTrajectoryEvent}s.
 *
 * Shared helpers and the external type now live in `common.ts` (AC7); this file
 * keeps only the Claude-Code-specific extraction. Its export
 * {@link adaptClaudeCodePostToolUse} is called per-event by the hook
 * (`src/hooks/post-tool-use.ts`) — signature and behavior are unchanged by the
 * refactor.
 */

import {
  asRecord,
  type ExternalTrajectoryEvent,
  externalEvent,
  firstNumber,
  firstString,
  tail,
} from "./common.js";

/** Strip the raw tool-input keys we re-expose as canonical `path`/`cmd`. */
function externalArgs(rawArgs: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = { ...rawArgs };
  for (const key of ["file_path", "filePath", "command"]) delete args[key];
  return args;
}

function adaptOne(input: unknown, step: number): ExternalTrajectoryEvent | undefined {
  const record = asRecord(input);
  const tool = firstString(record, ["tool", "tool_name", "name"]);
  if (tool === undefined) return undefined;

  const rawArgs = asRecord(record.args ?? record.input ?? record.tool_input);
  const path = firstString(rawArgs, ["path", "file_path", "filePath"]);
  const cmd = firstString(rawArgs, ["cmd", "command"]);
  // The real Claude Code `PostToolUse` payload carries the tool result under
  // `tool_response` (e.g. Bash → `{stdout, stderr, interrupted}`); older/internal
  // shapes used `result`. Read both so the same adapter serves the live hook and
  // the in-tree fixtures. Note: Bash `tool_response` has no exit code — that part
  // simply degrades (no `exit_code` emitted), it is never fabricated (NFR4).
  const result = asRecord(record.result);
  const response = asRecord(record.tool_response);
  const exitCode =
    firstNumber(record, ["exit_code", "exitCode"]) ??
    firstNumber(result, ["exit_code", "exitCode"]) ??
    firstNumber(response, ["exit_code", "exitCode"]);
  const stdoutTail = tail(
    record.stdout_tail ??
      record.stdout ??
      result.stdout_tail ??
      result.stdout ??
      response.stdout_tail ??
      response.stdout,
  );
  const stderrTail = tail(
    record.stderr_tail ??
      record.stderr ??
      result.stderr_tail ??
      result.stderr ??
      response.stderr_tail ??
      response.stderr,
  );
  const ts = firstString(record, ["ts", "timestamp"]);

  const args = externalArgs(rawArgs);
  if (path !== undefined) args.path = path;
  if (cmd !== undefined) args.cmd = cmd;

  return externalEvent(tool, args, firstNumber(record, ["step"]) ?? step, {
    ts,
    exitCode,
    stdoutTail,
    stderrTail,
  });
}

export function adaptClaudeCodePostToolUse(input: unknown): ExternalTrajectoryEvent[] {
  const inputs = Array.isArray(input) ? input : [input];
  return inputs.flatMap((item, index) => {
    const event = adaptOne(item, index + 1);
    return event === undefined ? [] : [event];
  });
}
