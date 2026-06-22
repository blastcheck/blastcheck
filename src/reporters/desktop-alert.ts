/**
 * Cross-platform desktop notification — the one place blastcheck raises an OS
 * alert (brief §5). Shared so every agent that lacks an in-band alert primitive
 * can reuse it: Codex routes its `fail` alert here via the user-level `notify`
 * program (Story 1.2), and OpenCode will reuse it (Story 1.3, also osascript).
 *
 * Posture: degrade quietly (brief §9 step 2). A missing binary, a non-zero shell
 * result, or any spawn error is swallowed — surfacing is best-effort and must
 * NEVER throw or become noise. `notify` fires for every Codex turn on the
 * machine, so a throw here would be both wrong and loud.
 */

import { spawnSync } from "node:child_process";

/**
 * Raise a desktop notification titled "blastcheck" carrying `headline`.
 *  - darwin → `osascript -e 'display notification "…" with title "blastcheck"'`
 *  - linux  → `notify-send blastcheck "…"`
 *  - otherwise → no-op.
 * All failures are swallowed (`.quiet().nothrow()`-style).
 */
export function desktopAlert(headline: string): void {
  try {
    if (process.platform === "darwin") {
      const script = `display notification ${osaQuote(headline)} with title "blastcheck"`;
      spawnSync("osascript", ["-e", script], { stdio: "ignore" });
    } else if (process.platform === "linux") {
      spawnSync("notify-send", ["blastcheck", headline], { stdio: "ignore" });
    }
    // Any other platform: no desktop-alert channel — silently no-op.
  } catch {
    // Degrade quietly: a missing binary / spawn failure is never fatal.
  }
}

/** Quote a string as an AppleScript double-quoted literal (escape `\` and `"`). */
function osaQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
