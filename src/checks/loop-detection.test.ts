import { describe, expect, it } from "vitest";
import { runChecks } from "../runner.js";
import { loadTrajectory } from "../trajectory/loader.js";
import type {
  CheckContext,
  Contract,
  TrajectoryCoverage,
  TrajectoryEvent,
  TrajectoryLoadResult,
} from "../types.js";
import { check } from "./loop-detection.js";

const FIXTURES = `${process.cwd()}/tests/fixtures/trajectories`;

function contract(): Contract {
  return {
    baselineSha: "base",
    goal: null,
    deny: [],
    allow: [],
    requiredChecks: [],
    budget: { maxToolCalls: 50, maxFilesChanged: 10, maxChurnPct: 10 },
    thresholds: {},
  };
}

function traj(
  events: TrajectoryEvent[],
  coverageOver: Partial<TrajectoryCoverage> = {},
): TrajectoryLoadResult {
  return {
    events,
    diagnostics: [],
    coverage: {
      totalLines: events.length,
      acceptedLines: events.length,
      rejectedLines: 0,
      hasStep: true,
      hasExitCode: events.some((e) => e.exitCode !== undefined),
      hasTimestamps: false,
      hasStdoutTail: false,
      missingFields: [],
      ...coverageOver,
    },
  };
}

function ctxOf(
  events: TrajectoryEvent[],
  coverageOver?: Partial<TrajectoryCoverage>,
): CheckContext {
  return { contract: contract(), trajectory: traj(events, coverageOver) };
}

function evidenceKinds(result: { findings: { evidence?: Record<string, unknown> }[] }): unknown[] {
  return result.findings.map((f) => f.evidence?.kind);
}

describe("loop-detection", () => {
  it("declares the trajectory score-check shape", () => {
    expect(check.id).toBe("loop-detection");
    expect(check.cls).toBe("trajectory");
    expect(check.requires).toEqual(["trajectory", "contract"]);
  });

  it("detects all four patterns in the combined fixture (violation)", async () => {
    const trajectory = await loadTrajectory(
      `${FIXTURES}/loop-detection__action-stuck-edit-spinning.trajectory.jsonl`,
    );
    const result = check.run({ contract: contract(), trajectory });

    expect(result.status).toBe("warn");
    expect(result.score).toBe(0);
    const kinds = evidenceKinds(result);
    expect(kinds).toContain("action");
    expect(kinds).toContain("stuck");
    expect(kinds).toContain("edit-churn");
    expect(kinds).toContain("spinning");
  });

  it("scores 1 with no findings on a productive run (clean)", async () => {
    const trajectory = await loadTrajectory(`${FIXTURES}/loop-detection__clean.trajectory.jsonl`);
    const result = check.run({ contract: contract(), trajectory });

    expect(result.status).toBe("pass");
    expect(result.score).toBe(1);
    expect(result.findings).toEqual([]);
  });

  it("flags an action loop (same non-recon call ≥3 within the window)", () => {
    const result = check.run(
      ctxOf([
        { tool: "Bash", args: { cmd: "rm x" }, step: 1 },
        { tool: "Bash", args: { cmd: "rm x" }, step: 2 },
        { tool: "Bash", args: { cmd: "rm x" }, step: 3 },
      ]),
    );
    expect(result.score).toBe(0);
    expect(evidenceKinds(result)).toContain("action");
  });

  it("flags a stuck loop (same non-zero exit code in a row)", () => {
    const result = check.run(
      ctxOf([
        { tool: "Bash", args: { cmd: "cmd a" }, step: 1, exitCode: 1 },
        { tool: "Bash", args: { cmd: "cmd b" }, step: 2, exitCode: 1 },
        { tool: "Bash", args: { cmd: "cmd c" }, step: 3, exitCode: 1 },
      ]),
    );
    expect(evidenceKinds(result)).toContain("stuck");
  });

  it("flags edit churn (one path edited ≥6 times)", () => {
    const events: TrajectoryEvent[] = Array.from({ length: 6 }, (_, i) => ({
      tool: "Edit",
      args: { path: "src/x.ts" },
      step: i + 1,
    }));
    const result = check.run(ctxOf(events));
    expect(evidenceKinds(result)).toContain("edit-churn");
  });

  it("flags spinning (≥K steps with no new file path)", () => {
    const events: TrajectoryEvent[] = Array.from({ length: 11 }, (_, i) => ({
      tool: "Bash",
      args: { cmd: `echo ${i}` }, // distinct → no action loop; no path → no new files
      step: i + 1,
    }));
    const result = check.run(ctxOf(events));
    expect(evidenceKinds(result)).toContain("spinning");
  });

  it("skips the stuck sub-check when the trace has no exit codes (partial)", () => {
    // Same exit codes would trip the stuck loop, but coverage says there are none
    // → the exit-code field degrades per-field; the check still returns a result.
    const result = check.run(
      ctxOf(
        [
          { tool: "Bash", args: { cmd: "cmd a" }, step: 1, exitCode: 1 },
          { tool: "Bash", args: { cmd: "cmd b" }, step: 2, exitCode: 1 },
          { tool: "Bash", args: { cmd: "cmd c" }, step: 3, exitCode: 1 },
        ],
        { hasExitCode: false },
      ),
    );
    expect(result.status).toBe("pass");
    expect(evidenceKinds(result)).not.toContain("stuck");
  });

  it("is skipped by the runner when no trajectory is present (no data)", () => {
    const { results, evidenceLevel } = runChecks([check], { contract: contract() });
    expect(results[0]?.status).toBe("skipped");
    expect(results[0]?.reason).toContain("trajectory");
    expect(evidenceLevel.checks["loop-detection"]).toBe("skipped");
  });
});
