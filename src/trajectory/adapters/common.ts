/**
 * Shared adapter layer (AC1, AC7).
 *
 * Every trajectory adapter (`claude-code` + the cross-agent `codex`/`cursor`/
 * `aider`) normalizes a native agent log into the SAME external contract: an
 * array of {@link ExternalTrajectoryEvent} (all `snake_case`). That common shape
 * — and the tiny liberal-parsing helpers used to extract it — live here so the
 * four adapters don't duplicate them. The output is consumed verbatim by
 * `loadTrajectory()` / `trajectoryEventSchema`; adapters never load, validate, or
 * compute coverage themselves (that is the loader/schema's job).
 *
 * Two invariants every adapter MUST hold:
 *  - Honest degradation (NFR4): a field the native log does not carry is simply
 *    not emitted — never fabricated. Missing `exit_code`/`ts`/tails degrade
 *    per-field downstream, they do not fail.
 *  - No record-level throw: an unknown/unparseable native entry is skipped (with
 *    a diagnostic), the remaining events survive. Throwing is reserved for
 *    file-level read errors, handled by the caller.
 */

import { normalize } from "../../match/normalize.js";

/**
 * The external, `snake_case` event shape emitted by every adapter and parsed by
 * `trajectoryEventSchema`. `tool` + `args` are the required core; the optional
 * fields are present only when the native log actually carried them.
 */
export type ExternalTrajectoryEvent = {
  tool: string;
  args: Record<string, unknown>;
  step: number;
  ts?: string;
  exit_code?: number;
  stdout_tail?: string;
  stderr_tail?: string;
};

/**
 * Canonical shell tool name (AC2). Exec-style native tools (`exec_command`,
 * `local_shell`, `shellToolCall`, `/run`, …) must be normalized to this so
 * `signature()` classifies them `kind:"cmd"` and the Bash security gate
 * (`denied-files`) and `required-checks` actually scan them. See
 * `src/match/signature.ts` `SHELL_TOOLS`.
 */
export const SHELL_TOOL = "shell";

/** A plain object, or `{}` for anything else (null/array/primitive). */
export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** First key whose value is a string, else `undefined`. */
export function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/** First key whose value is a finite number, else `undefined`. */
export function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** The last 20 lines of a string (a bounded tail), or `undefined` for non-strings. */
export function tail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const lines = value.split(/\r?\n/);
  return lines.slice(-20).join("\n");
}

/**
 * Build `args` for a file action — the normalized path under `args.path` (FR12,
 * via the shared {@link normalize}). Using the project normalizer keeps cross-
 * agent paths matchable against contract patterns without a bespoke normalizer.
 */
export function pathArgs(rawPath: string): Record<string, unknown> {
  return { path: normalize(rawPath) };
}

/** Build `args` for a shell action — the command under `args.cmd` (AC2). */
export function cmdArgs(command: string): Record<string, unknown> {
  return { cmd: command };
}

/** Optional fields for {@link externalEvent}, in internal `camelCase`. */
export interface EventTail {
  ts?: string;
  exitCode?: number;
  stdoutTail?: string;
  stderrTail?: string;
}

/**
 * Assemble an {@link ExternalTrajectoryEvent}, omitting every optional field
 * that is `undefined` (honest degradation — an absent field is never serialized
 * as `null`/`0`). Optionals are passed in `camelCase` and emitted `snake_case`.
 */
export function externalEvent(
  tool: string,
  args: Record<string, unknown>,
  step: number,
  optional: EventTail = {},
): ExternalTrajectoryEvent {
  const { ts, exitCode, stdoutTail, stderrTail } = optional;
  return {
    tool,
    args,
    step,
    ...(ts !== undefined ? { ts } : {}),
    ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
    ...(stdoutTail !== undefined ? { stdout_tail: stdoutTail } : {}),
    ...(stderrTail !== undefined ? { stderr_tail: stderrTail } : {}),
  };
}

/** Split raw text into lines, dropping only a single trailing newline (JSONL/NDJSON). */
export function splitLines(rawText: string): string[] {
  const lines = rawText.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** `JSON.parse` that returns `undefined` instead of throwing on malformed input. */
export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
