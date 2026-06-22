/**
 * Read-only readiness snapshot for `blastcheck status` (Story 1.4).
 *
 * Answers one question for a user: "is blastcheck actually connected here?"
 * It reads the install manifest plus the gitignored `.blastcheck/` evidence
 * files and reports installed integrations, evidence level, trust and the next
 * action — WITHOUT touching anything. This module performs filesystem reads
 * only: no writes, no `process.exit`, no stdout, and it never invokes an
 * installer (the Story 1.2/AC4 read-only contract). Missing binaries/config
 * degrade to warnings, never to a failure (FR41).
 *
 * Rendering is a separate, pure function (`renderReadiness`) so the snapshot
 * stays testable and a future `blastcheck doctor` can split deeper diagnostics
 * off the same data (AC4, FR43).
 */

import { access } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  baselinePath,
  fileHasContent,
  readStateFile,
  scorecardPath,
  trajectoryPath,
} from "../hooks/state.js";
import { readInstallManifest } from "./manifest.js";
import { supportedAgentsForMessage } from "./registry.js";
import { isExecutableOnPath } from "./runtime.js";
import type { AgentId, InstallManifestEntry, InstallTrustState } from "./types.js";

/** Evidence completeness per integration (UX-DR3). */
export type EvidenceState = "full" | "pending" | "git-only" | "absent";

/**
 * Runtime availability for an integration (FR40). `verified` ⇔ the agent's
 * runtime executable is resolvable on `PATH`; `unverified` ⇔ it is not. Only
 * OpenCode carries a runtime axis today; `undefined` (the absent field on other
 * integrations) means "runtime verification does not apply here".
 */
export type RuntimeState = "verified" | "unverified";

/**
 * Probes whether the runtime that would load `agent`'s integration is available.
 * Injected so tests stay independent of the host `PATH` (mirrors the adapter
 * seam in `runPostToolUse`). The default resolves the real PATH probe for
 * OpenCode and `false` for every other agent.
 */
export type RuntimeDetector = (agent: AgentId) => Promise<boolean>;

/** OpenCode CLI binary name — the runtime that auto-loads the local plugin. */
const OPENCODE_RUNTIME_BIN = "opencode";

const defaultDetectRuntime: RuntimeDetector = (agent) =>
  agent === "opencode" ? isExecutableOnPath(OPENCODE_RUNTIME_BIN) : Promise.resolve(false);

/** On-disk presence of one recorded config file. */
export interface ConfigFileStatus {
  path: string;
  present: boolean;
}

/** Readiness of a single installed integration. */
export interface IntegrationReadiness {
  agent: AgentId;
  displayName: string;
  configFiles: ConfigFileStatus[];
  trust?: InstallTrustState;
  evidence: EvidenceState;
  /**
   * Runtime availability (FR40), or `undefined` when runtime verification does
   * not apply to this integration (Claude Code / Codex / GitHub today). Reported
   * separately from `evidence` — they are independent signals (AC2).
   */
  runtime?: RuntimeState;
  /** Next action for the user, or `"—"` when nothing is needed. */
  actionNeeded: string;
}

/** Latest scorecard pointer (project-relative path + verdict, or unreadable). */
export interface ScorecardStatus {
  path: string;
  verdict?: "pass" | "warn" | "fail";
  unreadable?: boolean;
}

/** Everything `status` needs to render — a pure, testable data snapshot. */
export interface ReadinessSnapshot {
  integrations: IntegrationReadiness[];
  trajectoryPresent: boolean;
  baselinePresent: boolean;
  scorecard?: ScorecardStatus;
  /** Non-fatal readiness problems (missing config, unreadable scorecard, …). */
  warnings: string[];
  /** Supported agents string for the empty-manifest next step. */
  supportedAgents: string;
}

/** True when a path exists on disk (any kind). */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when an integration's recorded evidence path (project-relative) exists
 * and has content. A missing/empty recorded path means "no such evidence for
 * this integration" — never a throw.
 */
async function evidenceFileHasContent(cwd: string, rel: string | undefined): Promise<boolean> {
  if (rel === undefined || rel.length === 0) return false;
  return fileHasContent(join(cwd, rel));
}

/** Map presence flags to the fixed evidence vocabulary (UX-DR3). */
function computeEvidence(opts: {
  trajectoryPresent: boolean;
  baselinePresent: boolean;
  configPresent: boolean;
}): EvidenceState {
  if (opts.trajectoryPresent && opts.baselinePresent) return "full";
  if (opts.baselinePresent) return "git-only";
  if (opts.configPresent) return "pending";
  return "absent";
}

/**
 * Pick the single most useful next action for an integration (UX-DR4).
 *
 * Precedence (deterministic, most-fundamental-first):
 *   1. `needs-review` trust → review/trust the hooks.
 *   2. missing config file → re-install (the most basic breakage).
 *   3. `runtime === "unverified"` → install/run the runtime. An unverified
 *      runtime outranks pending evidence: if the runtime is absent, no session
 *      will ever capture a trajectory, so fixing it is the more useful hint.
 *   4. `evidence === "pending"` → run the agent once to capture a trajectory.
 *   5. else → `"—"`.
 */
function computeAction(opts: {
  agent: AgentId;
  trust?: InstallTrustState;
  hasMissingConfig: boolean;
  runtime?: RuntimeState;
  evidence: EvidenceState;
}): string {
  // A `needs-review` integration is installed but untrusted: the user must
  // review/trust the hooks in the agent. Codex does this via its `/hooks`
  // command (UX-DR4); other agents get a generic trust-review prompt.
  if (opts.trust === "needs-review") {
    return opts.agent === "codex"
      ? "review hooks in Codex `/hooks`"
      : `run trust review for ${opts.agent}`;
  }
  if (opts.hasMissingConfig) return `re-run \`blastcheck init --agent ${opts.agent}\``;
  if (opts.runtime === "unverified") return "install/run OpenCode to verify the runtime";
  if (opts.evidence === "pending") return "run your agent once to capture a trajectory";
  return "—";
}

/**
 * Build the readiness snapshot for `cwd`. Never throws on degradable state:
 * a missing/JSON-malformed manifest yields no integrations (the reader already
 * degrades those), a schema-invalid manifest is caught here and reported as a
 * warning, and a malformed scorecard becomes a warning — the command still
 * succeeds (FR41).
 */
export async function buildReadinessSnapshot(
  cwd: string,
  opts: { detectRuntime?: RuntimeDetector } = {},
): Promise<ReadinessSnapshot> {
  const detectRuntime = opts.detectRuntime ?? defaultDetectRuntime;
  const warnings: string[] = [];

  let manifestIntegrations: (InstallManifestEntry | undefined)[] = [];
  try {
    const manifest = await readInstallManifest(cwd);
    manifestIntegrations = Object.values(manifest.integrations);
  } catch (err) {
    // Schema-invalid manifest throws (Story 1.2). Status must not crash — it
    // reports a warning and continues as if nothing were installed.
    warnings.push(
      `install manifest is unreadable (${err instanceof Error ? err.message : String(err)}) — re-run \`blastcheck init\``,
    );
  }

  // The shared `.blastcheck/` directory holds one trajectory/baseline for the
  // whole repo. These repo-global flags drive the bottom "evidence:" summary
  // block only — per-integration evidence (below) is derived from each entry's
  // OWN recorded evidence paths so one integration's run is never attributed to
  // another that has not run (forward-looking for Epic 2/3 multi-integration).
  const trajectoryPresent = await fileHasContent(trajectoryPath(cwd));
  const baselineRaw = await readStateFile(baselinePath(cwd));
  const baselinePresent = baselineRaw !== undefined && baselineRaw.length > 0;

  const integrations: IntegrationReadiness[] = [];
  for (const entry of manifestIntegrations) {
    if (entry === undefined) continue;
    const configFiles: ConfigFileStatus[] = await Promise.all(
      entry.configFiles.map(async (p) => ({ path: p, present: await pathExists(join(cwd, p)) })),
    );
    const missing = configFiles.filter((c) => !c.present);
    for (const m of missing) {
      warnings.push(
        `${entry.agent}: recorded config ${m.path} is missing — re-run \`blastcheck init --agent ${entry.agent}\``,
      );
    }
    const configPresent = configFiles.some((c) => c.present);
    // Resolve evidence from THIS integration's recorded paths, not the global
    // files — so evidence is attributed per integration, not repo-wide.
    const entryTrajectoryPresent = await evidenceFileHasContent(
      cwd,
      entry.evidencePaths.trajectory,
    );
    const entryBaselinePresent = await evidenceFileHasContent(cwd, entry.evidencePaths.baseline);
    const evidence = computeEvidence({
      trajectoryPresent: entryTrajectoryPresent,
      baselinePresent: entryBaselinePresent,
      configPresent,
    });
    // Runtime is OpenCode-only for now (FR40): probe the runtime PATH for the
    // OpenCode entry, leave it `undefined` for every other agent so their rows
    // render unchanged (AC4). Runtime is orthogonal to evidence (AC2) — it never
    // feeds `computeEvidence`.
    let runtime: RuntimeState | undefined;
    if (entry.agent === "opencode") {
      // The injected seam could reject; `status` must never throw (FR41), so
      // degrade a rejected probe to "not verified" just like the PATH probe does.
      runtime = (await detectRuntime(entry.agent).catch(() => false)) ? "verified" : "unverified";
      // Only warn about the runtime when the plugin config is actually present
      // on disk (AC1 precondition). If config is missing, the missing-config
      // warning above already fired and outranks this — claiming "plugin
      // installed" here would contradict that state.
      if (runtime === "unverified" && missing.length === 0) {
        warnings.push(
          `${entry.agent}: plugin installed but OpenCode runtime not verified (\`${OPENCODE_RUNTIME_BIN}\` not found on PATH)`,
        );
      }
    }
    const actionNeeded = computeAction({
      agent: entry.agent,
      trust: entry.trust,
      hasMissingConfig: missing.length > 0,
      runtime,
      evidence,
    });
    integrations.push({
      agent: entry.agent,
      displayName: entry.displayName ?? entry.agent,
      configFiles,
      trust: entry.trust,
      evidence,
      ...(runtime === undefined ? {} : { runtime }),
      actionNeeded,
    });
  }

  const scorecard = await readScorecardStatus(cwd, warnings);

  return {
    integrations,
    trajectoryPresent,
    baselinePresent,
    scorecard,
    warnings,
    supportedAgents: supportedAgentsForMessage(),
  };
}

/**
 * Read the latest scorecard pointer. Absent → `undefined` (no scorecard yet).
 * Present + parseable verdict → path + verdict. Present but malformed →
 * `{ unreadable: true }` + a warning. We tolerantly read `.verdict` only; this
 * is a readiness pointer, not a re-validation of the whole scorecard schema.
 */
async function readScorecardStatus(
  cwd: string,
  warnings: string[],
): Promise<ScorecardStatus | undefined> {
  const raw = await readStateFile(scorecardPath(cwd));
  if (raw === undefined || raw.length === 0) return undefined;

  const path = relative(cwd, scorecardPath(cwd));
  try {
    const parsed: unknown = JSON.parse(raw);
    const verdict = (parsed as { verdict?: unknown })?.verdict;
    if (verdict === "pass" || verdict === "warn" || verdict === "fail") {
      return { path, verdict };
    }
    // Parsed fine, but the verdict is missing or not a recognized value — that
    // is a different problem from corrupt JSON, so say so distinctly.
    warnings.push("latest scorecard has no recognizable verdict");
    return { path, unreadable: true };
  } catch {
    warnings.push("latest scorecard is unreadable (not valid JSON)");
    return { path, unreadable: true };
  }
}

/**
 * Render the readiness snapshot to a list of human-readable lines (NFR22).
 * Pure: derives nothing the snapshot doesn't already hold. Kept small so a
 * future `blastcheck doctor` can carry the deeper, noisier detail (AC4).
 */
export function renderReadiness(snapshot: ReadinessSnapshot): string[] {
  const lines: string[] = ["blastcheck status"];

  if (snapshot.integrations.length === 0) {
    lines.push("  no integrations installed.");
    lines.push(
      `  next: run \`blastcheck init --agent <agent>\`  (supported: ${snapshot.supportedAgents})`,
    );
    appendWarnings(lines, snapshot.warnings);
    return lines;
  }

  lines.push("  integrations:");
  for (const it of snapshot.integrations) {
    const glyph = it.configFiles.every((c) => c.present) ? "✓" : "‼";
    const trust = it.trust ?? "—";
    // Runtime token is shown ONLY when the integration carries a runtime axis
    // (OpenCode today); other rows are byte-for-byte unchanged (AC4). It is its
    // own token, separate from the config-presence glyph and from evidence.
    const runtime =
      it.runtime === undefined
        ? ""
        : `   runtime: ${it.runtime === "verified" ? "verified" : "not verified"}`;
    lines.push(
      `    ${glyph} ${it.agent} (${it.displayName})   evidence: ${it.evidence}   trust: ${trust}${runtime}   action: ${it.actionNeeded}`,
    );
  }

  const configLines = snapshot.integrations.flatMap((it) => it.configFiles);
  if (configLines.length > 0) {
    lines.push("  config:");
    for (const c of configLines) {
      lines.push(`    ${c.present ? "✓" : "✗"} ${c.path}`);
    }
  }

  lines.push("  evidence:");
  lines.push(
    `    trajectory: ${snapshot.trajectoryPresent ? "present" : "absent"}   baseline: ${snapshot.baselinePresent ? "present" : "absent"}`,
  );
  if (snapshot.scorecard !== undefined) {
    const sc = snapshot.scorecard;
    lines.push(
      sc.unreadable === true
        ? `    latest scorecard: ${sc.path}  (unreadable)`
        : `    latest scorecard: ${sc.path}  verdict: ${sc.verdict}`,
    );
  }

  appendWarnings(lines, snapshot.warnings);
  return lines;
}

function appendWarnings(lines: string[], warnings: string[]): void {
  if (warnings.length === 0) return;
  lines.push("  warnings:");
  for (const w of warnings) {
    lines.push(`    - ${w}`);
  }
}

/** Print the readiness snapshot to STDERR only (stdout stays clean — NFR5). */
export function printReadiness(snapshot: ReadinessSnapshot): void {
  for (const line of renderReadiness(snapshot)) {
    process.stderr.write(`${line}\n`);
  }
}
