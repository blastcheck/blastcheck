/**
 * Three-source contract resolve (FR2, FR3, spec §1.1).
 *
 * Layering — each field comes from exactly one trust source:
 *  - `deny` / `budget` / `thresholds`: tool defaults, replaced/merged by
 *    `.blastcheck.yml` (the human's optional override).
 *  - `requiredChecks`: manifest autodetect (`source: 'auto'`) merged with
 *    `.blastcheck.yml` (`source: 'explicit'`); explicit wins on a `cmd` clash,
 *    upgrading that check to a hard gate.
 *  - `allow` / `goal`: read STRICTLY from `git show <baselineSha>:task.md` — the
 *    T0 pre-commitment. HEAD is never consulted, so the agent cannot rewrite its
 *    own promise after the fact (tamper-proof, FR3).
 *
 * Degradation (AR4): an absent or invalid `task.md` / `.blastcheck.yml` falls
 * back to safe defaults (empty `allow`, no overrides) with a logged warning —
 * `resolve` does NOT throw on bad external input. It throws ONLY when git itself
 * is unrecoverable (no repo / unreadable sha), which the adapter surfaces as a
 * `GitError` → exit 2 (rule #6).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { showTaskMd } from "../git/adapter.js";
import { log } from "../log.js";
import type { Budget, Contract, RequiredCheck } from "../types.js";
import { DEFAULT_BUDGET, DEFAULT_DENY, DEFAULT_THRESHOLDS } from "./defaults.js";
import { detectRequiredChecks } from "./detect.js";
import { type BlastcheckYmlOverride, blastcheckYmlSchema, taskMdSchema } from "./schema.js";

export interface ResolveOptions {
  /** The commit BEFORE the agent's run; `allow`/`goal` are pinned to it (FR3). */
  baselineSha: string;
  /** Repo working directory. Defaults to `process.cwd()`. */
  cwd?: string;
}

/** Extract a leading `---`-delimited YAML frontmatter block, or `null`. */
function extractFrontmatter(content: string): string | null {
  const withoutBom = content.replace(/^﻿/, "");
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(withoutBom);
  return m ? (m[1] ?? "") : null;
}

/**
 * Read `allow` / `goal` from the baseline `task.md` (FR3). Absent file, no
 * frontmatter, or invalid frontmatter all degrade to `{ allow: [], goal: null }`
 * — an empty `allow` is a valid (if penalized) absence of pre-commitment.
 */
async function resolveTaskMd(
  baselineSha: string,
  cwd: string,
): Promise<{ allow: string[]; goal: string | null }> {
  const content = await showTaskMd(baselineSha, { cwd });
  if (content === null) return { allow: [], goal: null };

  const frontmatter = extractFrontmatter(content);
  if (frontmatter === null) {
    log("debug", "contract: baseline task.md has no YAML frontmatter — empty allow");
    return { allow: [], goal: null };
  }

  let raw: unknown;
  try {
    raw = parseYaml(frontmatter);
  } catch (err) {
    log(
      "warn",
      `contract: task.md frontmatter is not valid YAML: ${err instanceof Error ? err.message : err}`,
    );
    return { allow: [], goal: null };
  }

  const parsed = taskMdSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    log("warn", `contract: task.md frontmatter failed validation: ${parsed.error.message}`);
    return { allow: [], goal: null };
  }
  return parsed.data;
}

/** Read and validate `.blastcheck.yml`; absent/invalid → no overrides (AR4). */
async function readOverrides(cwd: string): Promise<BlastcheckYmlOverride> {
  const empty: BlastcheckYmlOverride = {
    deny: undefined,
    requiredChecks: undefined,
    budget: undefined,
    thresholds: undefined,
  };

  let content: string;
  try {
    content = await readFile(join(cwd, ".blastcheck.yml"), "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      log(
        "warn",
        `contract: could not read .blastcheck.yml: ${err instanceof Error ? err.message : err}`,
      );
    }
    return empty;
  }

  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (err) {
    log(
      "warn",
      `contract: .blastcheck.yml is not valid YAML: ${err instanceof Error ? err.message : err}`,
    );
    return empty;
  }

  const parsed = blastcheckYmlSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    log("warn", `contract: .blastcheck.yml failed validation: ${parsed.error.message}`);
    return empty;
  }
  return parsed.data;
}

/** Merge defaults with only the *defined* override fields (undefined ≠ reset). */
function mergeBudget(override: BlastcheckYmlOverride["budget"]): Budget {
  if (!override) return { ...DEFAULT_BUDGET };
  return {
    maxToolCalls: override.maxToolCalls ?? DEFAULT_BUDGET.maxToolCalls,
    maxFilesChanged: override.maxFilesChanged ?? DEFAULT_BUDGET.maxFilesChanged,
    maxChurnPct: override.maxChurnPct ?? DEFAULT_BUDGET.maxChurnPct,
  };
}

/** Combine autodetected (`auto`) and explicit checks; explicit wins per `cmd`. */
function mergeRequiredChecks(
  auto: RequiredCheck[],
  explicitCmds: string[] | undefined,
): RequiredCheck[] {
  const byCmd = new Map<string, RequiredCheck>();
  for (const rc of auto) byCmd.set(rc.cmd, rc);
  for (const cmd of explicitCmds ?? []) byCmd.set(cmd, { cmd, source: "explicit" });
  return [...byCmd.values()];
}

/**
 * Merge threshold overrides onto defaults, but only for KNOWN score ids. An
 * unknown key (e.g. a typo like `scopeAdherance`) would otherwise be merged in
 * silently and never consumed — so we drop it and warn, surfacing the mistake.
 */
function mergeThresholds(override: Record<string, number> | undefined): Record<string, number> {
  const merged = { ...DEFAULT_THRESHOLDS };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (key in DEFAULT_THRESHOLDS) {
      merged[key] = value;
    } else {
      log("warn", `contract: ignoring unknown threshold "${key}" in .blastcheck.yml`);
    }
  }
  return merged;
}

/**
 * Assemble the full {@link Contract} from its three trust sources. See the
 * module header for the layering and degradation rules.
 */
export async function resolveContract(opts: ResolveOptions): Promise<Contract> {
  const cwd = opts.cwd ?? process.cwd();

  const [{ allow, goal }, overrides, auto] = await Promise.all([
    resolveTaskMd(opts.baselineSha, cwd),
    readOverrides(cwd),
    detectRequiredChecks(cwd),
  ]);

  return {
    baselineSha: opts.baselineSha,
    goal,
    allow,
    deny: overrides.deny ?? [...DEFAULT_DENY],
    requiredChecks: mergeRequiredChecks(auto, overrides.requiredChecks),
    budget: mergeBudget(overrides.budget),
    thresholds: mergeThresholds(overrides.thresholds),
  };
}
