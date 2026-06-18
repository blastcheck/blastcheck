/**
 * Cursor CLI `--output-format stream-json` adapter (AC1, AC2, AC3).
 *
 * Source: NDJSON, one event object per line. Event `type`s: `user`, `assistant`,
 * `tool_call` (with `subtype:"started"|"completed"`), `result`. Only `tool_call`
 * records carry actions; the rest are ignored. A tool call's invocation
 * (`started`) and its outcome (`completed`) are SEPARATE records correlated by a
 * tool-call id. The invocation nests the concrete call under a `*ToolCall` key:
 *   shellToolCall.args.command → shell + args.cmd  (AC2)
 *   read/write/editToolCall.args.path → args.path
 *
 * `completed` mirrors the structure and may carry `exit_code`/stdout/stderr —
 * which degrade honestly when absent (NFR4). Format reverse-engineered from
 * public sources (June 2026) and version-mobile; the committed fixture is the
 * contract. [Source: https://cursor.com/docs/cli/reference/output-format]
 */

import { log } from "../../log.js";
import {
  asRecord,
  cmdArgs,
  type EventTail,
  type ExternalTrajectoryEvent,
  externalEvent,
  firstNumber,
  firstString,
  pathArgs,
  SHELL_TOOL,
  splitLines,
  tail,
} from "./common.js";

const ID_KEYS = ["toolCallId", "id", "callId", "call_id"];

/** The tool-call id, from the `tool_call` object or its nested `*ToolCall` value. */
function toolCallId(toolCall: Record<string, unknown>): string | undefined {
  const top = firstString(toolCall, ID_KEYS);
  if (top !== undefined) return top;
  for (const [key, value] of Object.entries(toolCall)) {
    if (!key.endsWith("ToolCall")) continue;
    const id = firstString(asRecord(value), ID_KEYS);
    if (id !== undefined) return id;
  }
  return undefined;
}

interface ClassifiedCall {
  tool: string;
  args: Record<string, unknown>;
}

/**
 * Map the nested `*ToolCall` form to a normalized `{tool, args}`: shell calls →
 * `shell` + `args.cmd` (AC2), file calls → `args.path`. Unknown nested calls that
 * still carry a path or command are mapped by that signal; otherwise skipped.
 */
function classify(toolCall: Record<string, unknown>): ClassifiedCall | undefined {
  for (const [key, value] of Object.entries(toolCall)) {
    if (!key.endsWith("ToolCall")) continue;
    const args = asRecord(asRecord(value).args);

    if (key === "shellToolCall") {
      const cmd = firstString(args, ["command", "cmd"]);
      return cmd !== undefined ? { tool: SHELL_TOOL, args: cmdArgs(cmd) } : undefined;
    }

    const path = firstString(args, ["path", "file_path", "filePath"]);
    if (path !== undefined) {
      return { tool: key.replace(/ToolCall$/, ""), args: pathArgs(path) };
    }
    const cmd = firstString(args, ["command", "cmd"]);
    if (cmd !== undefined) return { tool: SHELL_TOOL, args: cmdArgs(cmd) };
  }
  return undefined;
}

/** Pull `exit_code`/tails out of a `completed` tool-call record (honest degradation). */
function completedTail(toolCall: Record<string, unknown>): EventTail {
  for (const [key, value] of Object.entries(toolCall)) {
    if (!key.endsWith("ToolCall")) continue;
    const inner = asRecord(value);
    const result = asRecord(inner.result);
    return {
      exitCode:
        firstNumber(inner, ["exit_code", "exitCode"]) ??
        firstNumber(result, ["exit_code", "exitCode"]),
      stdoutTail: tail(
        firstString(inner, ["stdout", "stdout_tail", "output"]) ??
          firstString(result, ["stdout", "stdout_tail", "output"]),
      ),
      stderrTail: tail(
        firstString(inner, ["stderr", "stderr_tail"]) ??
          firstString(result, ["stderr", "stderr_tail"]),
      ),
    };
  }
  return {};
}

interface StartedCall extends ClassifiedCall {
  id?: string;
  ts?: string;
  step: number;
}

export function adaptCursorStream(rawText: string): ExternalTrajectoryEvent[] {
  const started: StartedCall[] = [];
  const results = new Map<string, EventTail>();
  let step = 0;

  for (const [index, line] of splitLines(rawText).entries()) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      log("warn", `cursor: line ${index + 1} is not valid JSON — skipped`);
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;

    const record = parsed as Record<string, unknown>;
    if (firstString(record, ["type"]) !== "tool_call") continue; // user/assistant/result → ignore

    const toolCall = asRecord(record.tool_call);
    const subtype = firstString(record, ["subtype"]);

    if (subtype === "completed") {
      const id = toolCallId(toolCall);
      if (id !== undefined) results.set(id, completedTail(toolCall));
      continue;
    }

    // `started` (or a subtype-less tool_call) carries the action and its args.
    const classified = classify(toolCall);
    if (classified === undefined) continue;
    step += 1;
    started.push({
      ...classified,
      id: toolCallId(toolCall),
      ts: firstString(record, ["timestamp", "ts"]),
      step,
    });
  }

  return started.map((call) => {
    let outcome: EventTail | undefined;
    if (call.id !== undefined) {
      outcome = results.get(call.id);
      // Consume the result so a duplicate tool-call id can't copy the SAME
      // exit_code/tails onto a second invocation (that would fabricate it — NFR4).
      results.delete(call.id);
    }
    return externalEvent(call.tool, call.args, call.step, { ts: call.ts, ...outcome });
  });
}
