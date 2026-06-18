/**
 * Aider adapter (AC1, AC2, AC4).
 *
 * CHOSEN SOURCE: the markdown chat transcript `.aider.chat.history.md`. Aider has
 * NO structured tool-call JSONL — edits are emitted as SEARCH/REPLACE blocks in
 * markdown and shell runs as `/run <cmd>` lines. This is by far the poorest
 * source, so the goal here is HONEST DEGRADATION, not completeness (AC4):
 *   - edited file paths → `args.path`, read from the filename line that precedes
 *     each `<<<<<<< SEARCH` block (Aider's documented edit format),
 *   - `/run <cmd>` → `shell` + `args.cmd` (AC2).
 *
 * LIMITS (deliberately not extracted, because the transcript does not carry them
 * reliably — fabricating would be a false signal, NFR4):
 *   - no `exit_code`, no per-event `ts` (only a session-level header timestamp),
 *   - no stdout/stderr tails,
 *   - prose that merely mentions a path is NOT treated as an edit (the filename
 *     must sit directly above a SEARCH block), and a candidate filename with
 *     whitespace is rejected as prose.
 *
 * `step` is positional (order of appearance). [Source: https://aider.chat/docs/usage.html]
 */

import {
  cmdArgs,
  type ExternalTrajectoryEvent,
  externalEvent,
  pathArgs,
  SHELL_TOOL,
} from "./common.js";

const RUN_LINE = /^(?:#{1,4}\s+)?\/run\s+(.+)$/;
const SEARCH_MARKER = /^<{5,8}\s*SEARCH\b/;

/**
 * The filename that introduces a SEARCH/REPLACE block: the nearest preceding
 * non-blank line that is not a code fence or conflict marker. Bail (return
 * `undefined`) on a markdown heading or a whitespace-bearing line — those are
 * prose, not a path, and emitting them would be a false signal.
 */
function pathBefore(lines: string[], idx: number): string | undefined {
  for (let j = idx - 1; j >= 0 && idx - j <= 4; j--) {
    const text = (lines[j] ?? "").trim();
    if (text === "") continue;
    if (text.startsWith("```")) continue; // code fence
    if (/^[<=>]/.test(text)) continue; // conflict markers (=======, >>>>>>>)
    if (text.startsWith("#")) return undefined; // hit a heading before a filename
    if (/\s/.test(text)) return undefined; // prose, not a path
    return text;
  }
  return undefined;
}

export function adaptAiderHistory(rawText: string): ExternalTrajectoryEvent[] {
  const lines = rawText.split(/\r?\n/);
  const events: ExternalTrajectoryEvent[] = [];
  let step = 0;
  // Real `/run` commands are history markers OUTSIDE code fences; a `/run` quoted
  // inside a fenced example is not a command and emitting it would fabricate a
  // shell action (NFR4). SEARCH blocks legitimately live INSIDE fences, so they
  // stay fence-independent below.
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    const run = line.match(RUN_LINE);
    if (run?.[1] !== undefined) {
      if (!inFence) events.push(externalEvent(SHELL_TOOL, cmdArgs(run[1].trim()), ++step));
      continue;
    }

    if (SEARCH_MARKER.test(line.trim())) {
      const path = pathBefore(lines, i);
      if (path !== undefined) events.push(externalEvent("edit", pathArgs(path), ++step));
    }
  }

  return events;
}
