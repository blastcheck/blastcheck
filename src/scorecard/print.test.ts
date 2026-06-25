import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatScorecard, printScorecard } from "./print.js";
import type { Scorecard } from "./schema.js";

const scorecard: Scorecard = {
  schema_version: "1",
  run_id: "2026-06-17T00:00:00.000Z",
  agent: null,
  baseline_sha: "base000",
  head_sha: "head111",
  task_goal: "do it",
  verdict: "warn",
  evidence_level: { trajectory: "absent", checks: { "denied-files": "full" } },
  gates: { "denied-files": "pass" },
  scores: { scope_adherence: 0.83, churn_discipline: 0.91 },
  findings: [{ check: "scope-adhesion", severity: "info", message: "out of scope", path: "x.ts" }],
  stats: { files_changed: 2, lines_added: 88, lines_removed: 12, churn_pct: 2.1 },
};

describe("printScorecard", () => {
  let stderr: ReturnType<typeof vi.spyOn>;
  let stdout: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes the summary to stderr and NOTHING to stdout", () => {
    printScorecard(scorecard);
    expect(stderr).toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });

  it("renders verdict, gates, scores, findings and stats", () => {
    printScorecard(scorecard);
    const out = stderr.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("WARN");
    expect(out).toContain("denied-files: pass");
    expect(out).toContain("scope_adherence: 0.83");
    expect(out).toContain("[info] scope-adhesion: out of scope (x.ts)");
    expect(out).toContain("2 files, +88/-12, churn 2.1%");
  });
});

describe("formatScorecard", () => {
  let stderr: ReturnType<typeof vi.spyOn>;
  let stdout: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("RETURNS the rendered text and writes to NEITHER stream", () => {
    const out = formatScorecard(scorecard);
    expect(out).toContain("WARN");
    expect(out).toContain("denied-files: pass");
    expect(out).toContain("scope_adherence: 0.83");
    expect(out).toContain("[info] scope-adhesion: out of scope (x.ts)");
    expect(out).toContain("2 files, +88/-12, churn 2.1%");
    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });

  it("renders byte-identical to what printScorecard writes to stderr", () => {
    printScorecard(scorecard);
    const written = stderr.mock.calls.map((c) => String(c[0])).join("");
    expect(formatScorecard(scorecard)).toBe(written);
  });
});
