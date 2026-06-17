import { describe, expect, it } from "vitest";
import { allChecks } from "./registry.js";
// Importing the barrel registers the built-in checks as a side effect.
import "./index.js";

describe("built-in check registration", () => {
  it("registers all six checks in CHECK_IDS order", () => {
    const ids = allChecks().map((c) => c.id);
    expect(ids).toEqual([
      "denied-files",
      "scope-adhesion",
      "extraneous-tool-calls",
      "churn",
      "required-checks",
      "loop-detection",
    ]);
  });

  it("registers each check with a class and valid requires", () => {
    for (const c of allChecks()) {
      expect(["git-only", "trajectory"]).toContain(c.cls);
      expect(c.requires).toContain("contract");
      expect(typeof c.run).toBe("function");
    }
  });

  it("classifies the trajectory checks and gates them on a trajectory", () => {
    const byId = new Map(allChecks().map((c) => [c.id, c]));
    for (const id of ["extraneous-tool-calls", "required-checks", "loop-detection"] as const) {
      const c = byId.get(id);
      expect(c?.cls).toBe("trajectory");
      expect(c?.requires).toContain("trajectory");
    }
    // denied-files MUST stay git-only and MUST NOT require a trajectory, or the
    // git-only security gate would be skipped in Epic 1 runs.
    expect(byId.get("denied-files")?.cls).toBe("git-only");
    expect(byId.get("denied-files")?.requires).toEqual(["diff", "contract"]);
  });
});
