/**
 * Git access for the hook layer — a non-throwing wrapper over the git adapter.
 *
 * The audit path treats an unreadable HEAD as a tool error (exit 2), but a hook
 * must NEVER crash a Claude Code session. So `currentHead` swallows the adapter's
 * {@link GitError} and reports `undefined` instead, letting the caller degrade
 * (e.g. skip pre-commitment pinning when there is no git repo).
 */

import { headSha } from "../git/adapter.js";
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
