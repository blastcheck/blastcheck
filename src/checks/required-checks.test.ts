import { describe, expect, it } from "vitest";
import { runChecks } from "../runner.js";
import { loadTrajectory } from "../trajectory/loader.js";
import type {
  CheckContext,
  Contract,
  DiffEntry,
  RequiredCheck,
  TrajectoryEvent,
  TrajectoryLoadResult,
} from "../types.js";
import { check } from "./required-checks.js";

const FIXTURES = `${process.cwd()}/tests/fixtures/trajectories`;

function contract(requiredChecks: RequiredCheck[]): Contract {
  return {
    baselineSha: "base",
    goal: null,
    deny: [],
    allow: [],
    requiredChecks,
    budget: { maxToolCalls: 50, maxFilesChanged: 10, maxChurnPct: 10 },
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

const SOME_DIFF: DiffEntry[] = [{ path: "src/a.ts", added: 1, removed: 0 }];

describe("required-checks", () => {
  it("declares the trajectory gate shape (no score)", () => {
    expect(check.id).toBe("required-checks");
    expect(check.cls).toBe("trajectory");
    expect(check.requires).toEqual(["trajectory", "contract"]);
  });

  it("covers ran/passed, ran/failed, ran/unknown and missing in one pass (violation)", async () => {
    const trajectory = await loadTrajectory(
      `${FIXTURES}/required-checks__ran-passed-failed-missing.trajectory.jsonl`,
    );
    const ctx: CheckContext = {
      contract: contract([
        { cmd: "npm test", source: "explicit" }, // ran + passed → nothing
        { cmd: "npm run lint", source: "explicit" }, // ran + failed + changes → high/fail
        { cmd: "npm run build", source: "auto" }, // ran, no exit code → info
        { cmd: "pytest", source: "explicit" }, // missing + explicit → high/fail
        { cmd: "mypy", source: "auto" }, // missing + auto → warn
      ]),
      trajectory,
      diff: SOME_DIFF,
    };

    const result = check.run(ctx);

    expect(result.status).toBe("fail");
    expect("score" in result).toBe(false);
    const high = result.findings.filter((f) => f.severity === "high");
    const warn = result.findings.filter((f) => f.severity === "warn");
    const info = result.findings.filter((f) => f.severity === "info");
    expect(high).toHaveLength(2); // lint failure + missing pytest
    expect(warn).toHaveLength(1); // missing auto mypy
    expect(info).toHaveLength(1); // build ran, outcome unknown
    expect(high.some((f) => f.message.includes("pytest"))).toBe(true);
  });

  it("passes when every explicit required check ran and passed (clean)", () => {
    const ctx: CheckContext = {
      contract: contract([{ cmd: "npm test", source: "explicit" }]),
      trajectory: traj([{ tool: "Bash", args: { cmd: "npm test" }, step: 1, exitCode: 0 }]),
      diff: SOME_DIFF,
    };

    const result = check.run(ctx);

    expect(result.status).toBe("pass");
    expect(result.findings).toEqual([]);
  });

  it("an explicit check that never ran is a hard fail; an auto one only warns", () => {
    const trajectory = traj([{ tool: "Bash", args: { cmd: "echo hi" }, step: 1, exitCode: 0 }]);

    const explicit = check.run({
      contract: contract([{ cmd: "npm test", source: "explicit" }]),
      trajectory,
      diff: SOME_DIFF,
    });
    expect(explicit.status).toBe("fail");
    expect(explicit.findings[0]?.severity).toBe("high");

    const auto = check.run({
      contract: contract([{ cmd: "npm test", source: "auto" }]),
      trajectory,
      diff: SOME_DIFF,
    });
    expect(auto.status).toBe("warn");
    expect(auto.findings[0]?.severity).toBe("warn");
  });

  it("a failed required check only warns when the diff has no changes", () => {
    const ctx: CheckContext = {
      contract: contract([{ cmd: "npm test", source: "explicit" }]),
      trajectory: traj([{ tool: "Bash", args: { cmd: "npm test" }, step: 1, exitCode: 1 }]),
      diff: [], // nothing committed → not a hard gate
    };

    const result = check.run(ctx);

    expect(result.status).toBe("warn");
    expect(result.findings[0]?.severity).toBe("warn");
  });

  it("passes with no findings when the contract requires nothing", () => {
    const ctx: CheckContext = {
      contract: contract([]),
      trajectory: traj([{ tool: "Bash", args: { cmd: "npm test" }, step: 1, exitCode: 0 }]),
      diff: SOME_DIFF,
    };

    const result = check.run(ctx);

    expect(result.status).toBe("pass");
    expect(result.findings).toEqual([]);
  });

  it("is skipped by the runner when no trajectory is present (no data)", () => {
    const { results, evidenceLevel } = runChecks([check], {
      contract: contract([{ cmd: "npm test", source: "explicit" }]),
      diff: SOME_DIFF,
    });

    expect(results[0]?.status).toBe("skipped");
    expect(results[0]?.reason).toContain("trajectory");
    expect(evidenceLevel.checks["required-checks"]).toBe("skipped");
  });
});
