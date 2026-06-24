/**
 * Session state for the Claude Code hook layer (Story 3.1).
 *
 * Everything the hooks accumulate during a session lives under a gitignored
 * `.blastcheck/` directory at the repo root, so it never pollutes the audited
 * git diff (the trajectory and the recorded SHAs are NOT part of the change):
 *
 *  - `start_head`       HEAD at session start — the pre-commitment reference.
 *  - `baseline`         SHA of the first session commit = the audit baseline.
 *  - `trajectory.jsonl` normalized, loader-readable tool events (appended).
 *  - `scorecard.json`   a mirror of the last `Stop` scorecard (stdout is primary).
 *  - `last-surfaced`     state marker (`head_sha:worktree-hash`) of the last
 *                        surfaced verdict, so no-op turns stay silent (Story 1.1).
 *
 * These helpers never throw on a missing file — hooks must degrade quietly and
 * must never crash a Claude Code session (consistency rule #6).
 */

import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** The gitignored per-session state directory, relative to the repo root. */
export const STATE_DIR = ".blastcheck";

/** Absolute path to the state directory for a given working directory. */
export function stateDir(cwd: string): string {
  return join(cwd, STATE_DIR);
}

export function trajectoryPath(cwd: string): string {
  return join(cwd, STATE_DIR, "trajectory.jsonl");
}

export function startHeadPath(cwd: string): string {
  return join(cwd, STATE_DIR, "start_head");
}

export function baselinePath(cwd: string): string {
  return join(cwd, STATE_DIR, "baseline");
}

export function scorecardPath(cwd: string): string {
  return join(cwd, STATE_DIR, "scorecard.json");
}

/**
 * Path to the `last-surfaced` marker — the `head_sha:worktree-hash` state of the
 * last verdict the reporter actually surfaced. Lets a `hook stop` stay silent on
 * a no-op turn when nothing changed since the last surfaced verdict (Story 1.1).
 */
export function lastSurfacedPath(cwd: string): string {
  return join(cwd, STATE_DIR, "last-surfaced");
}

/** Read a small state file, trimmed; `undefined` when it does not exist. */
export async function readStateFile(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return undefined;
  }
}

/** Write a small state file, creating `.blastcheck/` if needed. */
export async function writeStateFile(path: string, content: string): Promise<void> {
  await mkdir(dirOf(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

/** Append a single line (a trailing newline is added) to a state file. */
export async function appendLine(path: string, line: string): Promise<void> {
  await mkdir(dirOf(path), { recursive: true });
  await appendFile(path, `${line}\n`, "utf8");
}

/** Truncate a file to empty (used to reset the trajectory on a new session). */
export async function clearFile(path: string): Promise<void> {
  await mkdir(dirOf(path), { recursive: true });
  await writeFile(path, "", "utf8");
}

/** Remove a file if present; a missing file is not an error. */
export async function removeFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

/** True when a file exists and contains at least one non-whitespace byte. */
export async function fileHasContent(path: string): Promise<boolean> {
  try {
    return (await readFile(path, "utf8")).trim().length > 0;
  } catch {
    return false;
  }
}

/** Read the entire stdin stream as UTF-8 text (empty string when no input). */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Parse a hook stdin payload as JSON; `undefined` on any malformed input. */
export function parseHookPayload(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function dirOf(path: string): string {
  return dirname(path);
}
