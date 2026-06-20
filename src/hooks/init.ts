/**
 * `blastcheck init` — installs the Claude Code hooks (AC1).
 *
 * Idempotently merges three hook entries into the project's
 * `.claude/settings.json` and ensures `.blastcheck/` is gitignored:
 *
 *  - `SessionStart` (matcher `startup|resume|clear`) → `blastcheck hook session-start`
 *  - `PostToolUse`  (matcher `*`)                    → `blastcheck hook post-tool-use`
 *  - `Stop`         (no matcher)                     → `blastcheck hook stop`
 *
 * Settings are parsed as JSON (never regex-patched). Re-running is a no-op: an
 * entry is added only when no hook command already references the same
 * `blastcheck hook <name>` marker, and unrelated user hooks/keys are preserved.
 * All progress is logged to stderr — `init` writes nothing to stdout (NFR9).
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../log.js";
import { type HookSpec, mergeHookSpecsIntoFile } from "./common.js";
import { STATE_DIR } from "./state.js";

/** The bin name assumed to be on PATH (npm global / npx). */
const BIN = "blastcheck";

const HOOK_SPECS: HookSpec[] = [
  { event: "SessionStart", matcher: "startup|resume|clear", command: `${BIN} hook session-start` },
  { event: "PostToolUse", matcher: "*", command: `${BIN} hook post-tool-use` },
  { event: "Stop", command: `${BIN} hook stop` },
];

export interface InitOptions {
  /** Repo working directory. Defaults to `process.cwd()`. */
  cwd?: string;
}

export interface InitResult {
  /** Number of hook entries newly added (0 when already fully installed). */
  added: number;
  settingsPath: string;
}

export async function runInit(opts: InitOptions = {}): Promise<InitResult> {
  const cwd = opts.cwd ?? process.cwd();
  const settingsPath = join(cwd, ".claude", "settings.json");

  // Shared JSON-hook-merge (also used by the Codex installer); strict
  // idempotency — a no-op re-run never rewrites settings.json.
  const added = await mergeHookSpecsIntoFile(settingsPath, HOOK_SPECS, "init");

  const ignored = await ensureGitignore(cwd);
  log(
    "info",
    `init: ${added} hook(s) added; .gitignore ${ignored ? "updated" : "already covers"} ${STATE_DIR}/`,
  );
  return { added, settingsPath };
}

/** Ensure `.blastcheck/` is in `.gitignore`. Returns `true` if it was changed. */
async function ensureGitignore(cwd: string): Promise<boolean> {
  const path = join(cwd, ".gitignore");
  const entry = `${STATE_DIR}/`;
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch {
    // no .gitignore yet
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(entry) || lines.includes(STATE_DIR)) return false;

  const prefix = text.length > 0 && !text.endsWith("\n") ? "\n" : "";
  await writeFile(path, `${text}${prefix}${entry}\n`, "utf8");
  return true;
}
