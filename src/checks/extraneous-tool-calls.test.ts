import { describe, expect, it } from "vitest";
import { runChecks } from "../runner.js";
import { loadTrajectory } from "../trajectory/loader.js";
import type { CheckContext, Contract, TrajectoryEvent, TrajectoryLoadResult } from "../types.js";
import { check } from "./extraneous-tool-calls.js";

const FIXTURES = `${process.cwd()}/tests/fixtures/trajectories`;

function contract(maxToolCalls = 50): Contract {
  return {
    baselineSha: "base",
    goal: null,
    deny: [],
    allow: [],
    requiredChecks: [],
    budget: { maxToolCalls, maxFilesChanged: 10, maxChurnPct: 10 },
    thresholds: {},
  };
}

function traj(events: TrajectoryEvent[]): TrajectoryLoadResult {
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
    },
  };
}

describe("extraneous-tool-calls", () => {
  it("declares the trajectory score-check shape", () => {
    expect(check.id).toBe("extraneous-tool-calls");
    expect(check.cls).toBe("trajectory");
    expect(check.requires).toEqual(["trajectory", "contract"]);
  });

  it("penalizes over-budget AND redundant calls, excluding recon (violation)", async () => {
    const trajectory = await loadTrajectory(
      `${FIXTURES}/extraneous__over-budget-and-redundant.trajectory.jsonl`,
    );
    // 6 calls total; budget 3 → overBudget 3. Non-recon: 3× Read src/app.ts + 1
    // npm test = 4, distinct 2 → redundant 2. git status / ls are recon (free).
    const ctx: CheckContext = { contract: contract(3), trajectory };

    const result = check.run(ctx);

    expect(result.status).toBe("pass"); // never a gate
    expect(result.score).toBeCloseTo(1 - (3 + 2) / 6);
    const ev = result.findings[0]?.evidence;
    expect(ev?.tool_calls_total).toBe(6);
    expect(ev?.over_budget).toBe(3);
    expect(ev?.redundant_calls).toBe(2);
    expect(ev?.histogram).toEqual({ Read: 3, Bash: 3 });
  });

  it("scores 1 on a lean, distinct, within-budget run (clean)", () => {
    const ctx: CheckContext = {
      contract: contract(50),
      trajectory: traj([
        { tool: "Read", args: { path: "src/a.ts" }, step: 1 },
        { tool: "Edit", args: { path: "src/b.ts" }, step: 2 },
        { tool: "Bash", args: { cmd: "npm test" }, step: 3, exitCode: 0 },
      ]),
    };

    const result = check.run(ctx);

    expect(result.status).toBe("pass");
    expect(result.score).toBe(1);
    expect(result.findings[0]?.evidence?.redundant_calls).toBe(0);
    expect(result.findings[0]?.evidence?.over_budget).toBe(0);
  });

  it("is skipped by the runner when no trajectory is present (no data)", () => {
    const { results, evidenceLevel } = runChecks([check], { contract: contract() });

    expect(results[0]?.status).toBe("skipped");
    expect(results[0]?.reason).toContain("trajectory");
    expect(evidenceLevel.checks["extraneous-tool-calls"]).toBe("skipped");
  });
});
