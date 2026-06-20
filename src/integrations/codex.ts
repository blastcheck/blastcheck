import { join } from "node:path";
import { type HookSpec, mergeHookSpecsIntoFile } from "../hooks/common.js";
import { STATE_DIR } from "../hooks/state.js";
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

    // Defensive copies so callers can't mutate the canonical manifest metadata.
    return {
      agent: entry.agent,
      configFiles: [...entry.configFiles],
      evidencePaths: { ...entry.evidencePaths },
      trust: entry.trust,
    };
  },
};
