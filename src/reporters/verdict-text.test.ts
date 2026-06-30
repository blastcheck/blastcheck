import { describe, expect, it } from "vitest";
import type { Scorecard } from "../scorecard/schema.js";
import { verdictDetail, verdictHeadline, verdictSubline } from "./verdict-text.js";

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
  it("empty: pass with no files changed reads as a dry no-op line", () => {
    expect(verdictHeadline(scorecard({ verdict: "pass" }))).toBe(
      "blastcheck: ✓ pass — no changes this session",
    );
  });

  it("clean: pass with files changed names the count and confirms scope", () => {
    const sc = scorecard({
      verdict: "pass",
      stats: { files_changed: 3, lines_added: 10, lines_removed: 2, churn_pct: 1.0 },
    });
    expect(verdictHeadline(sc)).toBe("blastcheck: ✓ pass — 3 files changed, scope ok");
  });

  it("fail-floor: a sub-floor score with no failed gate is restrained — no glyph, no upper-case", () => {
    const sc = scorecard({
      verdict: "fail",
      scores: { scope_adherence: 0.2 },
      findings: [{ severity: "high", check: "scope-adhesion", message: "out of scope" }],
    });
    expect(verdictHeadline(sc)).toBe(
      "blastcheck: fail — scope_adherence below floor · 1 high · 0 files, churn 0.0%",
    );
  });

  it("warn leads with the severity-mix, then git scale", () => {
    const sc = scorecard({
      verdict: "warn",
      findings: [{ severity: "warn", check: "churn", message: "high churn" }],
    });
    expect(verdictHeadline(sc)).toBe("blastcheck: ‼ warn — 1 warn · 0 files, churn 0.0%");
  });

  it("fail leads with the failed gate · severity-mix · scale, and upper-cases FAIL", () => {
    const sc = scorecard({
      verdict: "fail",
      gates: { "denied-files": "fail", churn: "pass" },
      findings: [
        { severity: "high", check: "denied-files", message: "touched .env", path: ".env" },
        { severity: "warn", check: "churn", message: "churn" },
      ],
    });
    expect(verdictHeadline(sc)).toBe(
      "blastcheck: ✗ FAIL — denied-files failed · 1 high, 1 warn · 0 files, churn 0.0%",
    );
  });

  it("renders the severity-mix loudest-first (high → warn → info), omitting zero buckets", () => {
    const sc = scorecard({
      verdict: "fail",
      gates: { "denied-files": "fail" },
      findings: [
        { severity: "info", check: "churn", message: "i" },
        { severity: "high", check: "denied-files", message: "h" },
        { severity: "warn", check: "churn", message: "w1" },
        { severity: "warn", check: "churn", message: "w2" },
      ],
    });
    // Insertion order is info→high→warn→warn, but the render is high→warn→info.
    // A failed gate ("denied-files") keeps this in the fail-gate alarm tier.
    expect(verdictHeadline(sc)).toBe(
      "blastcheck: ✗ FAIL — denied-files failed · 1 high, 2 warn, 1 info · 0 files, churn 0.0%",
    );
  });

  it("non-pass with no gates or findings still carries the scale segment", () => {
    // The always-present scale segment means `reason()` is never empty for a
    // non-pass verdict, so the `see scorecard` fallback no longer fires here.
    expect(verdictHeadline(scorecard({ verdict: "warn" }))).toBe(
      "blastcheck: ‼ warn — 0 files, churn 0.0%",
    );
  });
});

describe("verdictSubline", () => {
  it("warn with a required-checks warn finding: count-only, never echoes finding.message", () => {
    const sc = scorecard({
      verdict: "warn",
      findings: [
        {
          severity: "warn",
          check: "required-checks",
          message: "expected check (auto-detected) did not run: npm test",
        },
        {
          severity: "warn",
          check: "required-checks",
          message: "expected check (auto-detected) did not run: npm run lint",
        },
      ],
    });
    const sub = verdictSubline(sc);
    expect(sub).toBe("not run: 2 checks");
    expect(sub).not.toContain("npm test");
    expect(sub).not.toContain("npm run lint");
  });

  it("warn with no required-checks finding: undefined", () => {
    const sc = scorecard({
      verdict: "warn",
      findings: [{ severity: "warn", check: "churn", message: "high churn" }],
    });
    expect(verdictSubline(sc)).toBeUndefined();
  });

  it("fail-gate: a literal pointer at `blastcheck show`", () => {
    const sc = scorecard({ verdict: "fail", gates: { "denied-files": "fail" } });
    expect(verdictSubline(sc)).toBe("run `blastcheck show` for details");
  });

  it("fail-floor and pass: undefined (no second line)", () => {
    expect(verdictSubline(scorecard({ verdict: "fail", scores: { scope_adherence: 0.2 } }))).toBe(
      undefined,
    );
    expect(verdictSubline(scorecard({ verdict: "pass" }))).toBeUndefined();
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
