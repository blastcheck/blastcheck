/**
 * End-to-end: a native log → adapter → common jsonl → `loadTrajectory()` →
 * `signature()`. Proves AC2/AC5 — the adapter output is consumed by the SAME
 * loader/schema as the Claude Code path (no special-cases), and a cross-agent
 * shell command really lands as `signature().kind === "cmd"`, so it reaches the
 * Bash gate (`denied-files`) and `required-checks`.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { check as deniedFiles } from "../../checks/denied-files.js";
import { signature } from "../../match/signature.js";
import type { CheckContext, Contract, TrajectoryEvent } from "../../types.js";
import { loadTrajectory } from "../loader.js";
import { adaptLogToJsonl } from "./adapt.js";
import type { TrajectoryFormat } from "./index.js";

/** A contract that forbids `.env*`, used to drive the real Bash gate end-to-end. */
const DENY_ENV: Contract = {
  baselineSha: "base",
  goal: null,
  deny: ["**/.env*"],
  allow: ["src/**"],
  requiredChecks: [],
  budget: { maxToolCalls: 50, maxFilesChanged: 10, maxChurnPct: 10 },
  thresholds: {},
};

const FIXTURES = join(process.cwd(), "tests/fixtures/trajectories");

/** Adapt a fixture and run the real loader over its common jsonl. */
async function loadAdapted(format: TrajectoryFormat, fixture: string) {
  const raw = await readFile(join(FIXTURES, fixture), "utf8");
  const jsonl = adaptLogToJsonl(format, raw);
  const dir = await mkdtemp(join(tmpdir(), "blastcheck-adapt-e2e-"));
  const path = join(dir, "trajectory.jsonl");
  await writeFile(path, jsonl, "utf8");
  try {
    return await loadTrajectory(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const cmdOf = (event: TrajectoryEvent) => event.args.cmd;

describe("adapter → loader → signature (cross-agent)", () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("codex: shell commands classify as cmd/recon, patches as path; results give coverage", async () => {
    const result = await loadAdapted("codex", "codex-rollout.sample.jsonl");

    const rmCmd = result.events.find((e) => cmdOf(e) === "rm .env");
    const gitStatus = result.events.find((e) => cmdOf(e) === "git status");
    const patch = result.events.find((e) => e.args.path === "src/app.ts");

    // Destructive shell → kind:"cmd" → reaches the Bash gate (AC2). Without
    // name normalization it would be kind:"args" and silently escape.
    expect(rmCmd && signature(rmCmd).kind).toBe("cmd");
    expect(gitStatus && signature(gitStatus).kind).toBe("recon");
    expect(patch && signature(patch).kind).toBe("path");

    // Codex carries timestamps and one exit_code → those fields are covered.
    expect(result.coverage.hasTimestamps).toBe(true);
    expect(result.coverage.hasExitCode).toBe(true);
  });

  it("cursor: shell→cmd, write→path; absent ts degrades per-field, not fail", async () => {
    const result = await loadAdapted("cursor", "cursor-stream.sample.jsonl");

    const rmCmd = result.events.find((e) => cmdOf(e) === "rm .env");
    const diff = result.events.find((e) => cmdOf(e) === "git diff --stat");
    const write = result.events.find((e) => e.args.path === "src/new.ts");

    expect(rmCmd && signature(rmCmd).kind).toBe("cmd");
    expect(diff && signature(diff).kind).toBe("cmd");
    expect(write && signature(write).kind).toBe("path");

    // The Cursor stream fixture carries no per-event ts → honest per-field
    // degradation (a missing field, never a failure).
    expect(result.coverage.hasTimestamps).toBe(false);
    expect(result.coverage.missingFields).toContain("ts");
    expect(result.events.length).toBeGreaterThan(0);
  });

  it("aider: /run reaches the Bash gate; edits classify as path", async () => {
    const result = await loadAdapted("aider", "aider-history.sample.md");

    const rmCmd = result.events.find((e) => cmdOf(e) === "rm .env");
    const edit = result.events.find((e) => e.args.path === "src/app.ts");

    expect(rmCmd && signature(rmCmd).kind).toBe("cmd");
    expect(edit && signature(edit).kind).toBe("path");

    // Aider's poorest-source reality: no exit_code anywhere → degraded, not failed.
    expect(result.coverage.hasExitCode).toBe(false);
  });

  // AC8: prove the gate actually FIRES, not merely that the event is eligible.
  // Runs the real `denied-files` check (its Bash part) over each adapter's
  // trajectory and asserts `rm .env` yields a concrete high finding on `.env`.
  it.each<[TrajectoryFormat, string]>([
    ["codex", "codex-rollout.sample.jsonl"],
    ["cursor", "cursor-stream.sample.jsonl"],
    ["aider", "aider-history.sample.md"],
  ])("%s: rm .env produces a real denied-files finding (Bash gate fires)", async (format, fixture) => {
    const trajectory = await loadAdapted(format, fixture);
    const ctx: CheckContext = { contract: DENY_ENV, diff: [], trajectory };

    const result = deniedFiles.run(ctx);

    expect(result.status).toBe("fail");
    expect(result.findings.some((f) => f.path === ".env" && f.severity === "high")).toBe(true);
  });
});
