/**
 * Codex CLI rollout adapter (AC1, AC2, AC3).
 *
 * Source: `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. Each line is
 * `{ timestamp, type, payload }`. Tool invocations and their results are FLAT
 * records linked by `call_id` (not nested):
 *   - invocation: `{type:"response_item", payload:{type:"function_call",
 *       name, arguments:"<JSON string>", call_id}}`
 *   - result:     `{type:"response_item", payload:{type:"function_call_output",
 *       call_id, output}}`
 * `arguments` is a JSON STRING (parsed here). The exec tool is named
 * `shell`/`exec_command`/`local_shell`; file edits go through `apply_patch`.
 * Other `type`s (`event_msg/agent_message`, `token_count`, …) are ignored.
 *
 * Liberal-in, honest-out: a malformed line or unparseable `arguments` is skipped
 * with a stderr diagnostic — never thrown (AC3). `exit_code`/tails come from the
 * joined result if present, otherwise they are simply absent (NFR4).
 *
 * Format reverse-engineered from public sources (June 2026) and version-mobile;
 * the committed fixture is the contract we test against.
 * [Source: https://github.com/openai/codex/discussions/3827]
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
  tryParseJson,
} from "./common.js";

/** Codex exec-style tool names → normalized to the shell tool (AC2). */
const SHELL_NAMES = new Set(["shell", "exec_command", "local_shell", "container.exec"]);

/**
 * Is `bin` a shell binary? Compares the basename, so an absolute path
 * (`/bin/bash`, `/usr/bin/zsh`) is recognized as well as a bare `bash`/`sh`.
 */
function isShellBinary(bin: string): boolean {
  const base = bin.slice(bin.lastIndexOf("/") + 1);
  return /^(?:ba|z|k|da|a)?sh$/.test(base) || base === "fish";
}

/**
 * Extract a shell command from a parsed `arguments` object. Codex stores either
 * a plain string (`{command:"git status"}`) or an argv array, commonly the
 * wrapper `["bash","-lc","<script>"]` / `["sh","-c","<script>"]` — for which the
 * meaningful command is the trailing script, so recon detection still works.
 */
function extractCommand(args: Record<string, unknown>): string | undefined {
  const direct = firstString(args, ["command", "cmd", "script"]);
  if (direct !== undefined) return direct;

  const command = args.command;
  if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
    const parts = command as string[];
    const [shell, flag] = parts;
    // `<shell> -c|-lc <script>` wrapper — any shell binary (incl. zsh/fish and
    // absolute paths) with a `-…c` flag. The meaningful command is the trailing
    // script, so recon/denied-files detection sees `rm …`, not `zsh -c rm …`.
    if (
      parts.length >= 3 &&
      shell !== undefined &&
      flag !== undefined &&
      isShellBinary(shell) &&
      /^-[a-z]*c$/.test(flag)
    ) {
      return parts[parts.length - 1];
    }
    return parts.length > 0 ? parts.join(" ") : undefined;
  }
  return undefined;
}

/**
 * Extract an edited file path: a direct `path`-ish field, else the first
 * `*** Add/Update/Delete File: <path>` header of an `apply_patch` body.
 */
function extractPath(args: Record<string, unknown>): string | undefined {
  const direct = firstString(args, ["path", "file_path", "filePath"]);
  if (direct !== undefined) return direct;

  const patch = firstString(args, ["input", "patch", "diff"]);
  if (patch === undefined) return undefined;
  const match = patch.match(/\*\*\*\s+(?:Add|Update|Delete|Move|Rename)\s+File:\s+(.+)/);
  if (match?.[1] === undefined) return undefined;
  // Move/rename headers read `old -> new`; the destination is the touched path
  // (so denied-files/scope-adhesion see the file the patch actually writes).
  const header = match[1].trim();
  const arrow = header.split(/\s*->\s*/);
  return (arrow[arrow.length - 1] ?? header).trim();
}

/** Derive `exit_code`/tails from a `function_call_output` value (honest degradation). */
function resultTail(output: unknown): EventTail {
  let record: Record<string, unknown> | undefined;
  let text: string | undefined;

  if (typeof output === "string") {
    const parsed = tryParseJson(output);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      record = parsed as Record<string, unknown>;
    } else {
      text = output;
    }
  } else if (output !== null && typeof output === "object" && !Array.isArray(output)) {
    record = output as Record<string, unknown>;
  }

  if (record !== undefined) {
    const metadata = asRecord(record.metadata);
    return {
      exitCode:
        firstNumber(record, ["exit_code", "exitCode"]) ??
        firstNumber(metadata, ["exit_code", "exitCode"]),
      stdoutTail: tail(firstString(record, ["stdout", "stdout_tail", "output"])),
      stderrTail: tail(firstString(record, ["stderr", "stderr_tail"])),
    };
  }
  return { stdoutTail: tail(text) };
}

interface CodexCall {
  name: string;
  args: Record<string, unknown>;
  ts?: string;
  step: number;
}

export function adaptCodexRollout(rawText: string): ExternalTrajectoryEvent[] {
  const calls: Array<CodexCall & { callId?: string }> = [];
  const outputs = new Map<string, unknown>();
  let step = 0;

  for (const [index, line] of splitLines(rawText).entries()) {
    if (line.trim() === "") continue;
    const parsed = tryParseJson(line);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      log("warn", `codex: line ${index + 1} is not a JSON object — skipped`);
      continue;
    }

    const lineRecord = parsed as Record<string, unknown>;
    const payload = asRecord(lineRecord.payload);
    const payloadType = firstString(payload, ["type"]);
    const ts = firstString(lineRecord, ["timestamp", "ts"]);

    if (payloadType === "function_call") {
      step += 1;
      const name = firstString(payload, ["name", "tool", "tool_name"]);
      if (name === undefined) {
        log("warn", `codex: line ${index + 1} function_call without a name — skipped`);
        continue;
      }
      // `arguments` is a JSON string; tolerate an already-parsed object too.
      const rawArgs = payload.arguments;
      let args: Record<string, unknown> | undefined;
      if (typeof rawArgs === "string") {
        const decoded = tryParseJson(rawArgs);
        if (decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)) {
          args = decoded as Record<string, unknown>;
        } else {
          log("warn", `codex: line ${index + 1} has unparseable arguments — skipped`);
          continue;
        }
      } else {
        args = asRecord(rawArgs);
      }
      calls.push({ name, args, ts, step, callId: firstString(payload, ["call_id", "callId"]) });
    } else if (payloadType === "function_call_output") {
      const callId = firstString(payload, ["call_id", "callId"]);
      if (callId !== undefined) outputs.set(callId, payload.output);
    }
    // Any other payload type (agent_message, token_count, …) is intentionally ignored.
  }

  return calls.flatMap((call) => {
    const output = call.callId !== undefined ? outputs.get(call.callId) : undefined;
    const event = buildEvent(call, output);
    return event === undefined ? [] : [event];
  });
}

function buildEvent(call: CodexCall, output: unknown): ExternalTrajectoryEvent | undefined {
  const optional: EventTail = { ts: call.ts, ...resultTail(output) };

  if (SHELL_NAMES.has(call.name)) {
    const cmd = extractCommand(call.args);
    if (cmd === undefined) return undefined;
    return externalEvent(SHELL_TOOL, cmdArgs(cmd), call.step, optional);
  }

  const path = extractPath(call.args);
  if (path !== undefined) {
    return externalEvent(call.name, pathArgs(path), call.step, optional);
  }

  // Unknown tool with no path/cmd: preserve the action (don't lose it) only if it
  // carries some args the schema can accept as a fallback signal; else drop.
  return Object.keys(call.args).length > 0
    ? externalEvent(call.name, { ...call.args }, call.step, optional)
    : undefined;
}
