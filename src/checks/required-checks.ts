/**
 * Check `required-checks` — did the agent run the checks it had to? (FR10).
 * Class: trajectory. A GATE — `pass`/`warn`/`fail` status only, NEVER a `score`
 * (consistency rule #2).
 *
 * For each `contract.requiredChecks` pattern, scan the trajectory's Bash events
 * for a match:
 *  - `ran`    = at least one Bash command matched the pattern.
 *  - `passed` = taken from the LAST match's `exitCode` (`0` ⇒ passed, non-zero ⇒
 *    failed). No `exitCode` on the last match ⇒ `unknown` (NOT a failure — the
 *    trace was just thin; degrade, don't punish).
 *
 * Strictness by `RequiredCheck.source`:
 *  - `auto`     (detected from a repo manifest) + `!ran` → `warn` (soft gate — we
 *    won't crit-fail an agent for an instruction the tool itself invented).
 *  - `explicit` (a human wrote it in `.blastcheck.yml`) + `!ran` → `fail` (hard).
 *  - `ran && passed === false && there are changes in the diff` → `fail` (`high`).
 *
 * Decisions (story 2.2):
 *  - Match = SUBSTRING of the whitespace-normalized command (`'pytest'` matches
 *    `'python -m pytest -q'`). Pragmatic; precision calibration is deferred.
 *  - "committed" from the spec is read as "the diff has changes"
 *    (`(ctx.diff?.length ?? 0) > 0`) — the check has no real commit information.
 *  - A `warn` status does NOT appear in `scorecard.json.gates` (only pass/fail do)
 *    — that is fine; it still surfaces in `findings` and shapes the verdict.
 */

import { signature } from "../match/signature.js";
import type { Check, CheckContext, CheckResult, Finding, TrajectoryEvent } from "../types.js";

/** Collapse whitespace and trim — the same normal form `signature()` uses for cmds. */
function normCmd(cmd: string): string {
  return cmd.trim().replace(/\s+/g, " ");
}

/** The whitespace-normalized command of a non-recon shell event, or `null`. */
function shellCommand(event: TrajectoryEvent): string | null {
  if (event.args.cmd === undefined) return null;
  // Match required patterns only against real shell commands (`kind === 'cmd'`),
  // not recon (`cat`/`ls`/`pwd`/`git status`) — a required check must be an
  // executed command, per the story Dev Notes.
  if (signature(event).kind !== "cmd") return null;
  return normCmd(event.args.cmd);
}

function run(ctx: CheckContext): CheckResult {
  const events = ctx.trajectory?.events ?? [];
  const required = ctx.contract.requiredChecks;
  const hasChanges = (ctx.diff?.length ?? 0) > 0;

  // Precompute the shell commands once, paired with their event (events are
  // already sorted by `step`, so the last array entry is the last command).
  const shellEvents: Array<{ event: TrajectoryEvent; cmd: string }> = [];
  for (const event of events) {
    const cmd = shellCommand(event);
    if (cmd !== null) shellEvents.push({ event, cmd });
  }

  const findings: Finding[] = [];
  let anyFail = false;
  let anyWarn = false;

  for (const rc of required) {
    const pattern = normCmd(rc.cmd);
    if (pattern === "") continue; // empty pattern can never be a meaningful gate

    const matches = shellEvents.filter((s) => s.cmd.includes(pattern));
    const ran = matches.length > 0;

    if (!ran) {
      if (rc.source === "explicit") {
        anyFail = true;
        findings.push({
          severity: "high",
          message: `required check never ran: ${rc.cmd}`,
        });
      } else {
        anyWarn = true;
        findings.push({
          severity: "warn",
          message: `expected check (auto-detected) did not run: ${rc.cmd}`,
        });
      }
      continue;
    }

    // `passed` from the LAST matching command's exit code.
    const exitCode = matches[matches.length - 1]?.event.exitCode;

    if (exitCode === undefined) {
      // Ran, but the trace carries no outcome — report, do not fail.
      findings.push({
        severity: "info",
        message: `required check ran but outcome is unknown (no exit code): ${rc.cmd}`,
      });
      continue;
    }
    if (exitCode === 0) continue; // ran and passed — nothing to report

    // Ran and FAILED.
    if (hasChanges) {
      anyFail = true;
      findings.push({
        severity: "high",
        message: `required check failed (exit ${exitCode}) with changes in the diff: ${rc.cmd}`,
      });
    } else {
      anyWarn = true;
      findings.push({
        severity: "warn",
        message: `required check failed (exit ${exitCode}) but the diff has no changes: ${rc.cmd}`,
      });
    }
  }

  const status = anyFail ? "fail" : anyWarn ? "warn" : "pass";
  return { check: "required-checks", status, findings };
}

export const check: Check = {
  id: "required-checks",
  cls: "trajectory",
  requires: ["trajectory", "contract"],
  run,
};
