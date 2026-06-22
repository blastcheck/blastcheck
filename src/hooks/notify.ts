/**
 * `blastcheck notify codex <payload>` — the Codex user-level `notify` program.
 *
 * Codex has no Stop-output alert primitive, so the `fail` desktop alert is
 * decoupled from the Stop hook (brief §6.2/§7.4). Codex invokes the user-level
 * `notify` program on `agent-turn-complete`, passing the event payload as the
 * final argv positional (NOT stdin — `json.loads(sys.argv[1])` per the docs).
 * This handler reads `cwd` from that payload, reads the scorecard mirror
 * `runStop` wrote at `${cwd}/.blastcheck/scorecard.json`, and raises a desktop
 * alert ONLY when the verdict is `fail`.
 *
 * Critically, `notify` fires for EVERY Codex turn in EVERY project on the
 * machine — most of which have no blastcheck scorecard. So this MUST be a silent
 * no-op on a missing/unreadable/non-fail scorecard, a missing `cwd`, or a
 * malformed payload: never throw, never write stderr noise. The caller always
 * exits 0.
 */

import { readFile } from "node:fs/promises";
import { desktopAlert } from "../reporters/desktop-alert.js";
import { verdictHeadline } from "../reporters/verdict-text.js";
import type { Scorecard } from "../scorecard/schema.js";
import { scorecardPath } from "./state.js";

/** True for a non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Handle one Codex `agent-turn-complete` notify event. Always resolves; never
 * throws. Raises a desktop alert iff this repo's scorecard says `fail`.
 */
export async function runCodexNotify(payloadArg: string | undefined): Promise<void> {
  // No payload → nothing to act on (Codex always passes one, but be defensive).
  if (payloadArg === undefined) return;

  let payload: unknown;
  try {
    payload = JSON.parse(payloadArg);
  } catch {
    return; // malformed payload → silent no-op
  }
  if (!isObject(payload) || typeof payload.cwd !== "string") return;

  let raw: string;
  try {
    raw = await readFile(scorecardPath(payload.cwd), "utf8");
  } catch {
    return; // no scorecard in this project (the common case) → silent no-op
  }

  let scorecard: unknown;
  try {
    scorecard = JSON.parse(raw);
  } catch {
    return; // a corrupt mirror is not our problem to surface here
  }
  if (!isObject(scorecard) || scorecard.verdict !== "fail") return;

  // Only a `fail` raises the desktop alert (§7.1: alert on fail only). We only
  // validated `verdict` above, so a partial/corrupt mirror (e.g. `fail` with a
  // missing `gates`/`findings`) could make `verdictHeadline` dereference an
  // absent field and throw. Guard the render so this handler keeps its "never
  // throws, caller always exits 0" contract — notify fires for every project on
  // the machine, so a thrown stack trace here would be both wrong and loud.
  try {
    desktopAlert(verdictHeadline(scorecard as Scorecard));
  } catch {
    // Malformed scorecard shape → degrade quietly, no alert.
  }
}
