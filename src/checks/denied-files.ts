/**
 * Check `denied-files` — a HARD GATE in two parts (FR6, AR6/AR7).
 *
 * Class: git-only. The check has two complementary halves:
 *
 *  1. GIT part (always runs): flags any changed file (`ctx.diff`) that classifies
 *     into the `deny` bucket (priority `deny > allow > neither`, so a file in
 *     `allow ∩ deny` is still forbidden).
 *  2. BASH part (opportunistic, Story 2.2): when a trajectory is present, scans
 *     shell events for destructive operations (`rm`/`mv`/`>`/`>>`/`truncate`/
 *     `chmod`) whose target path lands in `deny`. This catches an agent that
 *     side-steps the git diff by mutating a denied file from the shell.
 *
 * Any hit in EITHER half → `status:'fail'` with one `Finding{severity:'high'}`
 * per hit. This is a gate: it NEVER sets `score` (consistency rule #2).
 *
 * Scope boundary (critical, do NOT regress — story 2.2 Dev Notes): the check
 * stays `requires: ['diff','contract']`, NOT `['trajectory', …]`. Adding
 * `'trajectory'` would make the runner skip the WHOLE gate in a git-only run,
 * removing the security boundary in Epic 1's main mode. So the trajectory is
 * read opportunistically from `ctx.trajectory` INSIDE `run()`; when it is absent,
 * the Bash part is simply not executed and the git part returns as before — never
 * a `skipped` for the whole check.
 *
 * Note on empty paths: `classify('')` returns `neither`; we defensively ignore
 * empty paths rather than letting one slip through as a false `pass`.
 */

import { classify, createMatcher, type Matcher } from "../match/matcher.js";
import { signature } from "../match/signature.js";
import type { Check, CheckContext, CheckResult, Finding, TrajectoryEvent } from "../types.js";

/** Commands whose path arguments mutate/destroy a file in place. */
const DESTRUCTIVE_CMDS = new Set(["rm", "mv", "truncate", "chmod"]);

/**
 * Options that consume the FOLLOWING token as their value, so it is NOT a path
 * argument (e.g. `truncate -s 0 file` — the `0` belongs to `-s`). Kept minimal
 * and per the GNU coreutils surface we actually parse.
 */
const OPTS_WITH_ARG = new Set(["-s", "--size", "--reference"]);

/**
 * Tokenize a shell command into separator-delimited segments of tokens. Single
 * and double quotes are unwrapped, backslash escapes the next char, and the
 * pipeline/list separators (`;` `|` `||` `&` `&&`) split segments. Redirections
 * `>` / `>>` / `<` are emitted as standalone tokens so the destructive-target
 * scan can find their operand. This is a pragmatic parser (standard library
 * only, no shell-grammar dependency — NFR), sufficient to spot the destructive
 * operations the gate cares about; it is not a full POSIX shell parser.
 */
function tokenizeShell(cmd: string): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  let token = "";
  let quote: '"' | "'" | null = null;

  const flushToken = (): void => {
    if (token !== "") {
      current.push(token);
      token = "";
    }
  };
  const flushSegment = (): void => {
    flushToken();
    if (current.length > 0) {
      segments.push(current);
      current = [];
    }
  };

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      else token += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "\\") {
      const next = cmd[i + 1];
      if (next !== undefined) {
        token += next;
        i++;
      }
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n") {
      flushToken();
      continue;
    }
    if (ch === ";") {
      flushSegment();
      continue;
    }
    if (ch === "|") {
      flushSegment();
      if (cmd[i + 1] === "|") i++;
      continue;
    }
    if (ch === "&") {
      flushSegment();
      if (cmd[i + 1] === "&") i++;
      continue;
    }
    if (ch === ">") {
      flushToken();
      if (cmd[i + 1] === ">") {
        current.push(">>");
        i++;
      } else {
        current.push(">");
      }
      continue;
    }
    if (ch === "<") {
      flushToken();
      current.push("<");
      continue;
    }
    token += ch;
  }
  flushSegment();
  return segments;
}

const REDIRECTS = new Set([">", ">>", "<"]);

/** The base command name of a segment (`/usr/bin/rm` → `rm`). */
function commandName(segment: string[]): string {
  const first = segment[0];
  if (first === undefined) return "";
  const slash = first.lastIndexOf("/");
  return slash >= 0 ? first.slice(slash + 1) : first;
}

/**
 * Extract candidate target paths from ONE command segment:
 *  - the operand of any `>` / `>>` redirect (overwrite/append destroys content);
 *  - for `rm`/`mv`/`truncate`/`chmod`, the non-flag path arguments. `chmod`'s
 *    first non-flag token is the MODE (`644`, `+x`), so it is skipped.
 */
function destructiveTargets(segment: string[]): string[] {
  const targets: string[] = [];
  const name = commandName(segment);
  const isDestructive = DESTRUCTIVE_CMDS.has(name);
  const skipFirstNonFlag = name === "chmod";
  let seenNonFlag = false;

  for (let i = 0; i < segment.length; i++) {
    const tok = segment[i];
    if (tok === undefined) continue;
    if (tok === ">" || tok === ">>") {
      const operand = segment[i + 1];
      if (operand !== undefined && !REDIRECTS.has(operand)) targets.push(operand);
      i++; // consume the operand
      continue;
    }
    if (tok === "<") {
      i++; // input redirect — operand is read, not destroyed
      continue;
    }
    if (i === 0 || !isDestructive) continue; // command name, or non-destructive cmd

    if (tok.startsWith("-") && tok !== "-") {
      if (OPTS_WITH_ARG.has(tok)) i++; // its value is not a path
      continue;
    }
    if (skipFirstNonFlag && !seenNonFlag) {
      seenNonFlag = true; // the mode argument of chmod
      continue;
    }
    targets.push(tok);
  }
  return targets;
}

/** Is this trajectory event a (non-recon) shell command we should scan? */
function isShellCommand(event: TrajectoryEvent): boolean {
  return event.args.cmd !== undefined && signature(event).kind === "cmd";
}

/**
 * Scan the trajectory's shell events for destructive operations on `deny` paths.
 * Returns one finding per (event, denied target). Recon commands are excluded by
 * {@link isShellCommand} (their signature kind is `recon`), and they are never
 * destructive anyway.
 */
function bashHits(events: TrajectoryEvent[], deny: Matcher): Finding[] {
  const findings: Finding[] = [];
  for (const event of events) {
    if (!isShellCommand(event)) continue;
    const cmd = event.args.cmd as string;
    for (const segment of tokenizeShell(cmd)) {
      for (const target of destructiveTargets(segment)) {
        if (deny.matches(target)) {
          findings.push({
            severity: "high",
            message: `shell command touched a denied file: ${target}`,
            path: target,
            evidence: { cmd, step: event.step },
          });
        }
      }
    }
  }
  return findings;
}

function run(ctx: CheckContext): CheckResult {
  const { contract } = ctx;
  const diff = ctx.diff ?? [];

  const deny = createMatcher(contract.deny);
  const allow = createMatcher(contract.allow);

  // GIT part — always runs.
  const forbidden = diff.filter((d) => d.path !== "" && classify(d.path, deny, allow) === "deny");
  const findings: Finding[] = forbidden.map((d) => ({
    severity: "high",
    message: `touched a denied file: ${d.path}`,
    path: d.path,
  }));

  // BASH part — opportunistic; only when a trajectory is present.
  if (ctx.trajectory) {
    findings.push(...bashHits(ctx.trajectory.events, deny));
  }

  if (findings.length === 0) {
    return { check: "denied-files", status: "pass", findings: [] };
  }
  return { check: "denied-files", status: "fail", findings };
}

export const check: Check = {
  id: "denied-files",
  cls: "git-only",
  requires: ["diff", "contract"],
  run,
};
