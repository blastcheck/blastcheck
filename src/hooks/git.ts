/**
 * Git access for the hook layer — a non-throwing wrapper over the git adapter.
 *
 * The audit path treats an unreadable HEAD as a tool error (exit 2), but a hook
 * must NEVER crash a Claude Code session. So `currentHead` swallows the adapter's
 * {@link GitError} and reports `undefined` instead, letting the caller degrade
 * (e.g. skip pre-commitment pinning when there is no git repo).
 */

import { createHash } from "node:crypto";
import { diffPatch, headSha } from "../git/adapter.js";
import { log } from "../log.js";

/** Current `HEAD` sha, or `undefined` when git is unavailable (no throw). */
export async function currentHead(cwd: string): Promise<string | undefined> {
  try {
    return await headSha({ cwd });
  } catch (err) {
    log("debug", `hook: git HEAD unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * A sha256 fingerprint of the audited surface (baseline → working tree), or
 * `undefined` when git is unavailable (no throw). Used to dedup no-op `hook stop`
 * turns: an unchanged signature means nothing changed since the last surfaced
 * verdict (Story 1.1). Hashed against the BASELINE, not HEAD — two distinct
 * uncommitted edits share a HEAD, so a HEAD-only marker would falsely silence a
 * real change. `undefined` means "cannot tell" → the caller must surface, never
 * dedup (degrade toward surfacing, never toward false silence).
 */
export async function worktreeSignature(
  cwd: string,
  baselineSha: string,
): Promise<string | undefined> {
  try {
    const patch = await diffPatch(baselineSha, { cwd });
    return createHash("sha256").update(patch).digest("hex");
  } catch (err) {
    log(
      "debug",
      `hook: worktree signature unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}
