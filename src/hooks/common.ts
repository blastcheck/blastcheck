/**
 * Shared JSON-hook-config merge primitives for the agent installers.
 *
 * Both Claude Code (`.claude/settings.json`) and Codex (`.codex/hooks.json`)
 * use the SAME hook-config shape:
 *
 *   { "hooks": { <Event>: [ { matcher?, hooks: [{ type:"command", command }] } ] } }
 *
 * so the install/merge logic is identical and lives here ONCE — `init.ts`
 * (Claude) and `src/integrations/codex.ts` (Codex) both call
 * {@link mergeHookSpecsIntoFile}. The config is always parsed as JSON and edited
 * as an object tree — never regex/string-patched (NFR7). Re-running is a no-op:
 * a spec is added only when no group of its event already references the exact
 * `command` marker, so managed entries are idempotent and identifiable for a
 * future uninstall (NFR8, NFR9). All progress is logged to stderr (NFR5).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { log } from "../log.js";

/** A `{type:'command'}` hook handler inside a matcher group. */
export interface HookHandler {
  type?: string;
  command?: string;
  [key: string]: unknown;
}

/** A matcher group: an optional `matcher` plus its handlers. */
export interface MatcherGroup {
  matcher?: string;
  hooks?: HookHandler[];
  [key: string]: unknown;
}

/** A hook-config document: a `hooks` map plus any unrelated top-level keys. */
export interface HookSettings {
  hooks?: Record<string, MatcherGroup[]>;
  [key: string]: unknown;
}

/** One managed hook to install: an event, an optional matcher, and a command. */
export interface HookSpec {
  event: string;
  /** `undefined` → a group with no matcher (match-all for `Stop`/`PostToolUse`). */
  matcher?: string;
  command: string;
}

/**
 * Read and parse a hook-config file; an absent/empty/invalid file yields `{}`
 * (with a stderr warning for the invalid cases) — never a throw, so a malformed
 * user config degrades to a fresh object instead of crashing the installer.
 * `label` prefixes the diagnostic (e.g. `"init"` / `"init codex"`).
 */
export async function readHookSettings(path: string, label: string): Promise<HookSettings> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    // Only a genuinely-missing file degrades to a fresh `{}`. An existing-but-
    // unreadable config (EACCES/EISDIR/EIO, …) must NOT be treated as absent —
    // doing so would let the subsequent merge overwrite a config we merely
    // failed to read. Anything other than ENOENT propagates.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    return {};
  }
  if (text.trim() === "") return {};
  try {
    const value: unknown = JSON.parse(text);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return value as HookSettings;
    }
    log("warn", `${label}: existing ${basename(path)} is not an object — starting fresh`);
    return {};
  } catch {
    log("warn", `${label}: existing ${basename(path)} is not valid JSON — starting fresh`);
    return {};
  }
}

/**
 * Idempotently add one hook spec to the parsed settings tree. Returns `true` if
 * it was added, `false` if an equivalent command already existed anywhere under
 * the event. Unrelated user hooks and top-level keys are left untouched.
 */
export function installHookSpec(settings: HookSettings, spec: HookSpec): boolean {
  // readHookSettings only guarantees the top-level value is a plain object; the
  // nested `hooks` map, its event arrays, and each group's `hooks` array may be
  // any JSON type in a hand-edited config. Coerce malformed nesting to fresh
  // structures rather than crashing — NFR7: a malformed config degrades, it
  // never throws an unguarded TypeError mid-merge.
  const hooks: Record<string, MatcherGroup[]> = isPlainObject(settings.hooks)
    ? (settings.hooks as Record<string, MatcherGroup[]>)
    : {};
  settings.hooks = hooks;
  const groups: MatcherGroup[] = Array.isArray(hooks[spec.event]) ? hooks[spec.event] : [];
  hooks[spec.event] = groups;

  // Already installed if ANY group of this event references our command — the
  // command string is the stable ownership/idempotency marker (NFR8/NFR9).
  const present = groups.some(
    (group) =>
      isPlainObject(group) &&
      (Array.isArray(group.hooks) ? group.hooks : []).some(
        (handler) => isPlainObject(handler) && handler.command === spec.command,
      ),
  );
  if (present) return false;

  const group = findOrCreateGroup(groups, spec.matcher);
  const handlers: HookHandler[] = Array.isArray(group.hooks) ? group.hooks : [];
  group.hooks = handlers;
  handlers.push({ type: "command", command: spec.command });
  return true;
}

/** True for a non-null, non-array object — the shape every hook node must have. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Find the matcher group with the given matcher, creating one if absent. */
function findOrCreateGroup(groups: MatcherGroup[], matcher?: string): MatcherGroup {
  const existing = groups.find((group) => isPlainObject(group) && group.matcher === matcher);
  if (existing !== undefined) return existing;
  const created: MatcherGroup = matcher === undefined ? { hooks: [] } : { matcher, hooks: [] };
  groups.push(created);
  return created;
}

/**
 * Merge `specs` into the JSON hook-config at `filePath` and persist the result.
 *
 * Strict idempotency: the file is written ONLY when at least one spec was newly
 * added, so a no-op re-run never rewrites the file (avoids mtime churn and
 * reformatting a user's differently-indented config). Returns the number of
 * specs newly added.
 */
export async function mergeHookSpecsIntoFile(
  filePath: string,
  specs: HookSpec[],
  label: string,
): Promise<number> {
  const settings = await readHookSettings(filePath, label);
  let added = 0;
  for (const spec of specs) {
    if (installHookSpec(settings, spec)) {
      added++;
      log("info", `${label}: installed ${spec.event} hook (${spec.command})`);
    } else {
      log("info", `${label}: ${spec.event} hook already present — skipped`);
    }
  }

  if (added > 0) {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  }
  return added;
}
