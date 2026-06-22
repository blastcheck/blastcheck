import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type HookSpec, mergeHookSpecsIntoFile } from "../hooks/common.js";
import { STATE_DIR } from "../hooks/state.js";
import { log } from "../log.js";
import { readInstallManifest, upsertInstallManifest } from "./manifest.js";
import type { AgentIntegration, InstallTrustState } from "./types.js";

/** The project-local Codex hook config blastcheck installs into (under `cwd`). */
const CODEX_CONFIG_FILES = [".codex/hooks.json"] as const;

/**
 * Canonical, shared `.blastcheck/` evidence paths. Codex reuses the SAME
 * trajectory/baseline/scorecard as Claude Code (FR23) — the audit core is
 * agent-agnostic, so there is one canonical evidence trio, not one per agent.
 */
const CODEX_EVIDENCE_PATHS = {
  trajectory: `${STATE_DIR}/trajectory.jsonl`,
  baseline: `${STATE_DIR}/baseline`,
  scorecard: `${STATE_DIR}/scorecard.json`,
} as const;

/** The bin name assumed to be on PATH (npm global / npx). */
const BIN = "blastcheck";

/**
 * The three lifecycle commands declared in `.codex/hooks.json`. The `command`
 * string (`blastcheck hook codex <name>`) doubles as the idempotency/ownership
 * marker (FR26/NFR8/NFR9). `PostToolUse`/`Stop` OMIT `matcher` for match-all:
 * the Codex docs accept `"*"`, `""`, or an omitted matcher, but `"*"` is not a
 * valid standalone regex, so omitting it avoids that ambiguity.
 */
const CODEX_HOOK_SPECS: HookSpec[] = [
  {
    event: "SessionStart",
    matcher: "startup|resume",
    command: `${BIN} hook codex session-start`,
  },
  { event: "PostToolUse", command: `${BIN} hook codex post-tool-use` },
  { event: "Stop", command: `${BIN} hook codex stop` },
];

/**
 * The exact `notify` line blastcheck installs into the USER-level
 * `~/.codex/config.toml` (FR8 + §7.4). Codex fires `notify` on
 * `agent-turn-complete` and honors it ONLY from the user-level config (a
 * project-local `.codex/config.toml notify` is ignored) — so this is the one
 * place blastcheck writes OUTSIDE the audited repo (into `$HOME`). The value
 * points Codex's notify program at `blastcheck notify codex` (the fail-alert
 * channel, since Codex has no Stop-output alert primitive).
 */
const CODEX_NOTIFY_VALUE = '["blastcheck", "notify", "codex"]';
const CODEX_NOTIFY_LINE = `notify = ${CODEX_NOTIFY_VALUE}`;

/** Outcome of the user-level `notify` write, so `install` can report it. */
type NotifyOutcome = "added" | "present" | "user-owned" | "unreadable";

/**
 * Non-destructively ensure the user-level `~/.codex/config.toml` carries our
 * `notify` entry. Dependency-free and line-aware (NO TOML parser — a round-trip
 * parse/stringify would reflow and strip the user's hand-written config and
 * comments; `src/contract/detect.ts` already scans TOML by line, not by parse).
 *
 *  - absent file / no top-level `notify` key → insert our line at the top and
 *    write (a bare key must precede any `[table]` header in TOML, so the very
 *    top is always valid).
 *  - our exact entry already present → no-op (strict idempotency, no mtime churn,
 *    mirroring the hook-merge contract in `common.ts`).
 *  - a different, user-owned `notify` → DO NOT overwrite it; leave it and report
 *    `user-owned` so `install` can surface a manual step (FR8 fallback).
 *
 * Never throws: an unreadable/unwritable `$HOME` config degrades to a reported
 * outcome, so a home-dir hiccup can't fail the whole install.
 */
async function ensureUserCodexNotify(configPath: string): Promise<NotifyOutcome> {
  let content: string;
  try {
    content = await readFile(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      content = ""; // fresh config — we'll create it
    } else {
      // An existing-but-unreadable config: do NOT clobber it; report so the
      // caller can surface the manual step.
      return "unreadable";
    }
  }

  // A top-level bare key must appear before the first `[table]` header in TOML,
  // so we only look for an existing top-level `notify` in that prefix. Track
  // open-array bracket depth as we scan: a line starting with `[` only marks a
  // table header at depth 0 — at depth > 0 it is a continuation element of a
  // multi-line top-level array value (e.g. `["a"],`) and must NOT be mistaken
  // for a table (that bug would stop the scan early, miss an existing `notify`
  // placed after the array, and prepend a DUPLICATE key on every re-run).
  const lines = content.split("\n");
  let depth = 0;
  for (const line of lines) {
    if (depth === 0) {
      if (/^\s*\[/.test(line)) break; // first real table header → end of top level
      if (/^\s*notify\s*=/.test(line)) {
        // Ours (byte-identical to what we write) → idempotent no-op. Anything
        // else is the user's — leave it untouched.
        return line.trimEnd() === CODEX_NOTIFY_LINE ? "present" : "user-owned";
      }
    }
    // Net bracket balance of this line carries the array depth to the next one.
    for (const ch of line) {
      if (ch === "[") depth++;
      else if (ch === "]") depth = Math.max(0, depth - 1);
    }
  }

  // Not present: prepend our line. Keep every existing byte (non-destructive).
  const next = content === "" ? `${CODEX_NOTIFY_LINE}\n` : `${CODEX_NOTIFY_LINE}\n${content}`;
  try {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, next, "utf8");
  } catch {
    return "unreadable"; // couldn't create/write $HOME config — report, don't throw
  }
  return "added";
}

/** Report the user-level `notify` outcome to stderr (NFR5: progress on stderr). */
function reportNotifyOutcome(outcome: NotifyOutcome, configPath: string): void {
  switch (outcome) {
    case "added":
      log("info", `init codex: added user-level notify to ${configPath}`);
      break;
    case "present":
      log("info", "init codex: user-level notify already present — skipped");
      break;
    case "user-owned":
      log(
        "warn",
        `init codex: ${configPath} already has a different notify — left it untouched. ` +
          `To enable the blastcheck fail-alert, set notify = ${CODEX_NOTIFY_VALUE} (or chain it).`,
      );
      break;
    case "unreadable":
      log(
        "warn",
        `init codex: could not read/write ${configPath} — set notify = ${CODEX_NOTIFY_VALUE} ` +
          "there manually to enable the blastcheck fail-alert.",
      );
      break;
  }
}

export const codexIntegration: AgentIntegration = {
  id: "codex",
  displayName: "Codex",
  async install(options) {
    // Structured, non-destructive JSON merge into `.codex/hooks.json`: user
    // hooks and unrelated keys are preserved; a no-op re-run leaves the file
    // untouched. Shared with the Claude installer (one merge implementation).
    const hooksPath = join(options.cwd, ".codex", "hooks.json");
    const added = await mergeHookSpecsIntoFile(hooksPath, CODEX_HOOK_SPECS, "init codex");

    // Trust is `needs-review` by default (FR24): Codex requires the user to
    // review and trust non-managed command hooks via `/hooks`, and there is no
    // reliable signal that they completed it — so never auto-mark `trusted`.
    // BUT a no-op re-run (nothing newly added) must not silently downgrade an
    // entry the user already elevated to `trusted`: the live hooks are byte-
    // identical to what they reviewed, so their review still holds. A re-run
    // that actually installs a managed command resets to `needs-review` —
    // the new command has not been reviewed.
    const previousTrust = (await readInstallManifest(options.cwd)).integrations.codex?.trust;
    const trust: InstallTrustState =
      added === 0 && previousTrust === "trusted" ? "trusted" : "needs-review";
    const entry = {
      agent: "codex" as const,
      displayName: "Codex",
      configFiles: [...CODEX_CONFIG_FILES],
      evidencePaths: { ...CODEX_EVIDENCE_PATHS },
      trust,
      updatedAt: new Date().toISOString(),
    };
    await upsertInstallManifest(options.cwd, entry);

    // User-level `notify` (FR8/§7.4): Codex's desktop fail-alert channel. This is
    // the ONE write OUTSIDE the audited repo — into `~/.codex/config.toml`, since
    // a project-local notify is ignored. The hook DEFINITIONS are untouched, so
    // no `/hooks` re-trust is needed (AC8). Non-fatal: a $HOME hiccup degrades to
    // a surfaced manual step, never a failed install.
    const codexConfigPath = join(homedir(), ".codex", "config.toml");
    reportNotifyOutcome(await ensureUserCodexNotify(codexConfigPath), codexConfigPath);

    // Defensive copies so callers can't mutate the canonical manifest metadata.
    return {
      agent: entry.agent,
      configFiles: [...entry.configFiles],
      evidencePaths: { ...entry.evidencePaths },
      trust: entry.trust,
    };
  },
};
