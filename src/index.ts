/**
 * Public API surface (AR9).
 *
 * `runAudit(input) → Scorecard` is the single public entry point. Both the CLI
 * (`cli.ts`) and the future GitHub Action consume THIS module — `cli.ts` is a
 * thin wrapper (arg parsing, exit code, stdout). In this story `runAudit` is a
 * signature stub; full orchestration lands in Story 1.2 (runner) and 1.4
 * (verdict/CLI).
 */

import type { CheckResult } from "./types.js";

export { CHECK_IDS, isCheckId } from "./checks/registry.js";
// Re-export the foundation type surface for API consumers.
export type {
  Budget,
  Check,
  CheckClass,
  CheckContext,
  CheckCoverage,
  CheckId,
  CheckResult,
  CheckStatus,
  Contract,
  DiffEntry,
  EvidenceLevel,
  ExitCode,
  Field,
  Finding,
  RequiredCheck,
} from "./types.js";
export { EXIT } from "./types.js";

/** Input to {@link runAudit}. Full shape lands in Story 1.2/1.4. */
export interface AuditInput {
  /** Repo working directory. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Path to the audit contract file. */
  contractPath?: string;
}

/** Machine-readable audit output. Full shape lands in Story 1.4. */
export interface Scorecard {
  verdict: "pass" | "fail";
  results: CheckResult[];
}

/**
 * Run a full audit and produce a {@link Scorecard}.
 *
 * STUB: orchestration (contract assembly, runner, verdict) is implemented in
 * Story 1.2 and 1.4. Calling it now throws — `cli.ts` maps that to exit `2`.
 */
export function runAudit(_input: AuditInput): Scorecard {
  throw new Error(
    "runAudit is not implemented yet — audit orchestration arrives in Story 1.2 (runner) and 1.4 (verdict/CLI).",
  );
}
