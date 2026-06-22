import { describe, expect, it } from "vitest";
import type { Scorecard } from "../scorecard/schema.js";
import { verdictDetail, verdictHeadline } from "./verdict-text.js";

function scorecard(overrides: Partial<Scorecard> = {}): Scorecard {
  return {
    schema_version: "1",
    run_id: "test-run",
    agent: null,
    baseline_sha: "base",
    head_sha: "head",
    task_goal: null,
    verdict: "pass",
    evidence_level: { trajectory: "absent", checks: {} },
    gates: {},
    scores: {},
    findings: [],
    stats: { files_changed: 0, lines_added: 0, lines_removed: 0, churn_pct: 0 },
    ...overrides,
  };
}

describe("verdictHeadline", () => {
  it("pass reads as a calm all-clear line", () => {
    expect(verdictHeadline(scorecard({ verdict: "pass" }))).toBe("blastcheck: ✓ pass — all clear");
  });

  it("warn counts findings", () => {
    const sc = scorecard({
      verdict: "warn",
      findings: [{ severity: "warn", check: "churn", message: "high churn" }],
    });
    expect(verdictHeadline(sc)).toBe("blastcheck: ‼ warn — 1 finding");
  });

  it("fail leads with the failed gate, then the finding count, and upper-cases FAIL", () => {
    const sc = scorecard({
      verdict: "fail",
      gates: { "denied-files": "fail", churn: "pass" },
      findings: [
        { severity: "high", check: "denied-files", message: "touched .env", path: ".env" },
        { severity: "warn", check: "churn", message: "churn" },
      ],
    });
    expect(verdictHeadline(sc)).toBe("blastcheck: ✗ FAIL — denied-files failed; 2 findings");
  });

  it("falls back when a non-pass verdict has no gates or findings", () => {
    expect(verdictHeadline(scorecard({ verdict: "warn" }))).toBe(
      "blastcheck: ‼ warn — see scorecard",
    );
  });
});

describe("verdictDetail", () => {
  it("restates the verdict, failing gates, findings, and where to look", () => {
    const sc = scorecard({
      verdict: "fail",
      gates: { "denied-files": "fail" },
      findings: [
        { severity: "high", check: "denied-files", message: "touched .env", path: ".env" },
      ],
    });
    const detail = verdictDetail(sc);
    expect(detail).toContain("blastcheck: ✗ FAIL");
    expect(detail).toContain("gate failed: denied-files");
    expect(detail).toContain("[high] denied-files: touched .env (.env)");
    expect(detail).toContain(".blastcheck/scorecard.json");
  });
});
