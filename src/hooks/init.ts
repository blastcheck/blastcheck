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

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../log.js";
import { STATE_DIR } from "./state.js";

/** A `{type:'command'}` hook handler inside a matcher group. */
interface HookHandler {
  type?: string;
  command?: string;
  [key: string]: unknown;
}

/** A matcher group: an optional `matcher` plus its handlers. */
interface MatcherGroup {
  matcher?: string;
  hooks?: HookHandler[];
  [key: string]: unknown;
}

interface Settings {
  hooks?: Record<string, MatcherGroup[]>;
  [key: string]: unknown;
}

interface HookSpec {
  event: string;
  /** `undefined` → a group with no matcher (used for `Stop`). */
  matcher?: string;
  command: string;
}

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

  const settings = await readSettings(settingsPath);
  let added = 0;
  for (const spec of HOOK_SPECS) {
    if (installHook(settings, spec)) {
      added++;
      log("info", `init: installed ${spec.event} hook (${spec.command})`);
    } else {
      log("info", `init: ${spec.event} hook already present — skipped`);
    }
  }

  // Strict idempotency: only touch settings.json when we actually added a hook.
  // A no-op re-run must not rewrite the file (avoids mtime churn and reformatting
  // a user's differently-indented settings).
  if (added > 0) {
    await mkdir(join(cwd, ".claude"), { recursive: true });
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  }

  const ignored = await ensureGitignore(cwd);
  log(
    "info",
    `init: ${added} hook(s) added; .gitignore ${ignored ? "updated" : "already covers"} ${STATE_DIR}/`,
  );
  return { added, settingsPath };
}

/** Read and parse `.claude/settings.json`; an absent/empty file yields `{}`. */
async function readSettings(path: string): Promise<Settings> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return {};
  }
  if (text.trim() === "") return {};
  try {
    const value: unknown = JSON.parse(text);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return value as Settings;
    }
    log("warn", "init: existing settings.json is not an object — starting fresh");
    return {};
  } catch {
    log("warn", "init: existing settings.json is not valid JSON — starting fresh");
    return {};
  }
}

/**
 * Idempotently add one hook spec. Returns `true` if it was added, `false` if an
 * equivalent command already existed anywhere under the event.
 */
function installHook(settings: Settings, spec: HookSpec): boolean {
  const hooks: Record<string, MatcherGroup[]> = settings.hooks ?? {};
  settings.hooks = hooks;
  const groups: MatcherGroup[] = hooks[spec.event] ?? [];
  hooks[spec.event] = groups;

  // Already installed if ANY group of this event references our command.
  const present = groups.some((group) =>
    (group.hooks ?? []).some((handler) => handler.command === spec.command),
  );
  if (present) return false;

  const group = findOrCreateGroup(groups, spec.matcher);
  const handlers: HookHandler[] = group.hooks ?? [];
  group.hooks = handlers;
  handlers.push({ type: "command", command: spec.command });
  return true;
}

/** Find the matcher group with the given matcher, creating one if absent. */
function findOrCreateGroup(groups: MatcherGroup[], matcher?: string): MatcherGroup {
  const existing = groups.find((group) => group.matcher === matcher);
  if (existing !== undefined) return existing;
  const created: MatcherGroup = matcher === undefined ? { hooks: [] } : { matcher, hooks: [] };
  groups.push(created);
  return created;
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
