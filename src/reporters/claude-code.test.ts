import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Scorecard } from "../scorecard/schema.js";
import { EXIT } from "../types.js";
import { buildClaudeCodeStopOutput, claudeCodeReporter } from "./claude-code.js";
import { DEFAULT_SURFACING, type SurfacingOptions } from "./types.js";

const BEL = String.fromCharCode(7); // 
const ESC = String.fromCharCode(27); // 

function scorecard(verdict: Scorecard["verdict"], overrides: Partial<Scorecard> = {}): Scorecard {
  return {
    schema_version: "1",
    run_id: "test-run",
    agent: "claude-code",
    baseline_sha: "base",
    head_sha: "head",
    task_goal: null,
    verdict,
    evidence_level: { trajectory: "present", checks: {} },
    gates: {},
    scores: {},
    findings: [],
    stats: { files_changed: 1, lines_added: 1, lines_removed: 0, churn_pct: 0 },
    ...overrides,
  };
}

function ctx(verdict: Scorecard["verdict"], overrides?: Partial<Scorecard>) {
  return { scorecard: scorecard(verdict, overrides), json: "{}" };
}

const opts = (o: Partial<SurfacingOptions> = {}): SurfacingOptions => ({
  ...DEFAULT_SURFACING,
  ...o,
});

describe("buildClaudeCodeStopOutput", () => {
  it("pass: a brief visible line, no alert / feedback / block", () => {
    const out = buildClaudeCodeStopOutput(ctx("pass"), opts());
    expect(out).toEqual({ systemMessage: "blastcheck: ✓ pass — all clear" });
  });

  it("warn: a visible line, but NO desktop alert (alert is fail-only, §7.1)", () => {
    const out = buildClaudeCodeStopOutput(
      ctx("warn", { findings: [{ severity: "warn", check: "churn", message: "x" }] }),
      opts(),
    );
    expect(out.systemMessage).toBe("blastcheck: ‼ warn — 1 finding");
    expect(out.terminalSequence).toBeUndefined();
  });

  it("fail: a visible line PLUS a terminalSequence desktop alert (BEL + OSC 9)", () => {
    const out = buildClaudeCodeStopOutput(
      ctx("fail", { gates: { "denied-files": "fail" } }),
      opts(),
    );
    const headline = "blastcheck: ✗ FAIL — denied-files failed";
    expect(out.systemMessage).toBe(headline);
    // A terminal bell (BEL), then an OSC 9 desktop notification carrying the headline.
    expect(out.terminalSequence).toBe(`${BEL}${ESC}]9;${headline}${BEL}`);
  });

  it("feedback opt-in: adds additionalContext on a fail; default off adds nothing", () => {
    const off = buildClaudeCodeStopOutput(ctx("fail"), opts());
    expect(off.hookSpecificOutput).toBeUndefined();

    const on = buildClaudeCodeStopOutput(ctx("fail"), opts({ feedback: true }));
    expect(on.hookSpecificOutput).toMatchObject({ hookEventName: "Stop" });
    expect((on.hookSpecificOutput as { additionalContext: string }).additionalContext).toContain(
      "blastcheck: ✗ FAIL",
    );
  });

  it("feedback opt-in does NOT fire on pass", () => {
    const out = buildClaudeCodeStopOutput(ctx("pass"), opts({ feedback: true }));
    expect(out).toEqual({ systemMessage: "blastcheck: ✓ pass — all clear" });
  });

  it("block opt-in: a fail emits decision:block + reason, and subsumes feedback", () => {
    const out = buildClaudeCodeStopOutput(ctx("fail"), opts({ block: true, feedback: true }));
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("blastcheck: ✗ FAIL");
    // block already feeds `reason` back — don't also duplicate via additionalContext.
    expect(out.hookSpecificOutput).toBeUndefined();
  });

  it("block does NOT apply to warn (warn never blocks)", () => {
    const out = buildClaudeCodeStopOutput(ctx("warn"), opts({ block: true }));
    expect(out.decision).toBeUndefined();
  });
});

describe("claudeCodeReporter.surface", () => {
  let stdout: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(() => vi.restoreAllMocks());

  it("writes the hook JSON to stdout and ALWAYS exits 0 (verdict rides in systemMessage)", async () => {
    const code = await claudeCodeReporter.surface(ctx("fail"), DEFAULT_SURFACING);
    expect(code).toBe(EXIT.OK);
    const written = stdout.mock.calls.map((c) => c[0]).join("");
    expect(JSON.parse(written).systemMessage).toContain("FAIL");
  });

  it("does NOT write the raw scorecard to stdout (only hook JSON)", async () => {
    await claudeCodeReporter.surface(ctx("pass"), DEFAULT_SURFACING);
    const written = stdout.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(written);
    expect(parsed.schema_version).toBeUndefined();
    expect(parsed.systemMessage).toBeDefined();
  });
});
