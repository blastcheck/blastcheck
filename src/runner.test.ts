import { describe, expect, it } from "vitest";
import { runChecks } from "./runner.js";
import type { Check, CheckContext, Contract } from "./types.js";

const CONTRACT: Contract = {
  baselineSha: "abc",
  goal: null,
  deny: [],
  allow: [],
  requiredChecks: [],
  budget: { maxToolCalls: 50, maxFilesChanged: 10, maxChurnPct: 10 },
  thresholds: {},
};

/** A minimal passing check that records whether it actually ran. */
function fakeCheck(overrides: Partial<Check> & Pick<Check, "id">): Check {
  return {
    cls: "git-only",
    requires: [],
    run: () => ({ check: overrides.id, status: "pass", findings: [] }),
    ...overrides,
  };
}

describe("runChecks", () => {
  it("runs a check whose required fields are all present", () => {
    const check = fakeCheck({ id: "churn", requires: ["diff", "repoSize"] });
    const ctx: CheckContext = { contract: CONTRACT, diff: [], repoSize: 100 };

    const { results, evidenceLevel } = runChecks([check], ctx);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("pass");
    expect(evidenceLevel.checks.churn).toBe("full");
  });

  it("skips (without calling) a check missing required data, naming the gap", () => {
    let ran = false;
    const check = fakeCheck({
      id: "required-checks",
      requires: ["trajectory"],
      run: () => {
        ran = true;
        return { check: "required-checks", status: "pass", findings: [] };
      },
    });
    const ctx: CheckContext = { contract: CONTRACT };

    const { results, evidenceLevel } = runChecks([check], ctx);

    expect(ran).toBe(false);
    const result = results[0];
    expect(result?.status).toBe("skipped");
    expect(result?.reason).toContain("trajectory");
    // skipped invariant (rule #2): reason set, findings [], no score.
    expect(result?.findings).toEqual([]);
    expect(result && "score" in result).toBe(false);
    expect(evidenceLevel.checks["required-checks"]).toBe("skipped");
    expect(evidenceLevel.trajectory).toBe("absent");
  });

  it("treats an empty diff as available data (not missing)", () => {
    const check = fakeCheck({ id: "scope-adhesion", requires: ["diff"] });
    const ctx: CheckContext = { contract: CONTRACT, diff: [] };

    const { results } = runChecks([check], ctx);

    expect(results[0]?.status).toBe("pass");
  });

  it("reports trajectory present when a trajectory is supplied", () => {
    const ctx: CheckContext = { contract: CONTRACT, trajectory: [] };
    const { evidenceLevel } = runChecks([], ctx);
    expect(evidenceLevel.trajectory).toBe("present");
  });

  it("contains a throwing check instead of aborting the whole pass", () => {
    const boom = fakeCheck({
      id: "denied-files",
      run: () => {
        throw new Error("boom");
      },
    });
    const ok = fakeCheck({ id: "churn" });

    const { results } = runChecks([boom, ok], { contract: CONTRACT });

    expect(results[0]?.status).toBe("skipped");
    expect(results[0]?.reason).toMatch(/unexpected error/);
    // The later check still runs.
    expect(results[1]?.status).toBe("pass");
  });

  it("preserves check order in results", () => {
    const a = fakeCheck({ id: "denied-files" });
    const b = fakeCheck({ id: "churn" });
    const c = fakeCheck({ id: "scope-adhesion" });

    const { results } = runChecks([a, b, c], { contract: CONTRACT });

    expect(results.map((r) => r.check)).toEqual(["denied-files", "churn", "scope-adhesion"]);
  });
});
