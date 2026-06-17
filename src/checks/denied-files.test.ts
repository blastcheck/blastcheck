import { describe, expect, it } from "vitest";
import { runChecks } from "../runner.js";
import { loadTrajectory } from "../trajectory/loader.js";
import type {
  CheckContext,
  Contract,
  DiffEntry,
  TrajectoryEvent,
  TrajectoryLoadResult,
} from "../types.js";
import { check } from "./denied-files.js";

const FIXTURES = `${process.cwd()}/tests/fixtures/trajectories`;

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

function contract(over: Partial<Contract> = {}): Contract {
  return {
    baselineSha: "base",
    goal: null,
    deny: ["**/*.lock", ".github/**"],
    allow: ["src/**"],
    requiredChecks: [],
    budget: { maxToolCalls: 50, maxFilesChanged: 10, maxChurnPct: 10 },
    thresholds: {},
    ...over,
  };
}

function diff(...paths: string[]): DiffEntry[] {
  return paths.map((path) => ({ path, added: 1, removed: 0 }));
}

describe("denied-files", () => {
  it("declares the git-only gate shape", () => {
    expect(check.id).toBe("denied-files");
    expect(check.cls).toBe("git-only");
    expect(check.requires).toEqual(["diff", "contract"]);
  });

  it("fails with a high finding per forbidden file (violation)", () => {
    const ctx: CheckContext = {
      contract: contract(),
      diff: diff("yarn.lock", "src/app.ts", ".github/workflows/ci.yml"),
    };

    const result = check.run(ctx);

    expect(result.status).toBe("fail");
    expect(result.findings).toHaveLength(2);
    expect(result.findings.every((f) => f.severity === "high")).toBe(true);
    expect(result.findings.map((f) => f.path)).toEqual(["yarn.lock", ".github/workflows/ci.yml"]);
    // A gate never carries a score (rule #2).
    expect("score" in result).toBe(false);
  });

  it("passes with no findings and no score when nothing is denied (clean)", () => {
    const ctx: CheckContext = { contract: contract(), diff: diff("src/app.ts", "README.md") };

    const result = check.run(ctx);

    expect(result.status).toBe("pass");
    expect(result.findings).toEqual([]);
    expect("score" in result).toBe(false);
  });

  it("treats a file in allow ∩ deny as forbidden (deny wins)", () => {
    // src/secrets.json is in allow (src/**) AND deny (**/secrets*).
    const ctx: CheckContext = {
      contract: contract({ deny: ["**/secrets*"], allow: ["src/**"] }),
      diff: diff("src/secrets.json"),
    };

    const result = check.run(ctx);

    expect(result.status).toBe("fail");
    expect(result.findings[0]?.path).toBe("src/secrets.json");
  });

  it("is skipped by the runner when diff data is absent (no data)", () => {
    const { results, evidenceLevel } = runChecks([check], { contract: contract() });

    expect(results[0]?.status).toBe("skipped");
    expect(results[0]?.reason).toContain("diff");
    expect(evidenceLevel.checks["denied-files"]).toBe("skipped");
  });

  // --- Bash part of the gate (Story 2.2) -----------------------------------

  const denyCtx = (over: Partial<Contract> = {}): Contract =>
    contract({ deny: ["**/.env*", "migrations/**", "**/secrets*"], allow: ["src/**"], ...over });

  it("fails on destructive shell ops over deny paths (Bash violation)", async () => {
    const trajectory = await loadTrajectory(
      `${FIXTURES}/denied-files__bash-hits-deny.trajectory.jsonl`,
    );
    // Clean git diff: every hit comes from the Bash part.
    const ctx: CheckContext = { contract: denyCtx(), diff: diff("src/app.ts"), trajectory };

    const result = check.run(ctx);

    expect(result.status).toBe("fail");
    expect(result.findings.every((f) => f.severity === "high")).toBe(true);
    const paths = result.findings.map((f) => f.path);
    expect(paths).toContain(".env"); // rm .env
    expect(paths).toContain("config/.env.local"); // > redirect
    expect(paths).toContain("migrations/001_init.sql"); // chmod
    expect(paths).toContain("secrets.json"); // mv source
    // `rm src/app.ts` (allowed) and `cat package.json` (recon) are NOT hits.
    expect(paths).not.toContain("src/app.ts");
  });

  it("passes when destructive shell ops target only allowed paths (Bash clean)", async () => {
    const trajectory = await loadTrajectory(
      `${FIXTURES}/denied-files__bash-clean.trajectory.jsonl`,
    );
    const ctx: CheckContext = { contract: denyCtx(), diff: diff("src/x.ts"), trajectory };

    const result = check.run(ctx);

    expect(result.status).toBe("pass");
    expect(result.findings).toEqual([]);
  });

  it("merges git and Bash hits into a single failing result", () => {
    const ctx: CheckContext = {
      contract: denyCtx(),
      diff: diff("migrations/002.sql"), // git-part hit
      trajectory: traj([{ tool: "Bash", args: { cmd: "rm .env" }, step: 1, exitCode: 0 }]), // bash hit
    };

    const result = check.run(ctx);

    expect(result.status).toBe("fail");
    expect(result.findings.map((f) => f.path).sort()).toEqual([".env", "migrations/002.sql"]);
  });

  it("ignores the Bash part entirely when no trajectory is present (git part only)", () => {
    const ctx: CheckContext = { contract: denyCtx(), diff: diff("src/app.ts") };

    const result = check.run(ctx);

    expect(result.status).toBe("pass");
    expect(result.findings).toEqual([]);
  });
});
