import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Scorecard } from "../scorecard/schema.js";
import { EXIT } from "../types.js";
import { buildCodexStopOutput, codexReporter } from "./codex.js";
import { DEFAULT_SURFACING, type SurfacingOptions } from "./types.js";

function scorecard(verdict: Scorecard["verdict"], overrides: Partial<Scorecard> = {}): Scorecard {
  return {
    schema_version: "1",
    run_id: "test-run",
    agent: "codex",
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

describe("buildCodexStopOutput", () => {
  it("pass: a brief visible line via systemMessage, nothing else", () => {
    const out = buildCodexStopOutput(ctx("pass"), opts());
    expect(out).toEqual({ systemMessage: "blastcheck: ✓ pass — all clear" });
  });

  it("warn: a visible line, no alert field, no feedback", () => {
    const out = buildCodexStopOutput(
      ctx("warn", { findings: [{ severity: "warn", check: "churn", message: "x" }] }),
      opts(),
    );
    expect(out.systemMessage).toBe("blastcheck: ‼ warn — 1 finding");
    // Codex Stop output has no alert primitive — never a terminalSequence.
    expect(out.terminalSequence).toBeUndefined();
    expect(out.hookSpecificOutput).toBeUndefined();
    expect(out.decision).toBeUndefined();
  });

  it("fail: systemMessage ONLY — no terminalSequence/alert field (alert rides notify, not this output)", () => {
    const out = buildCodexStopOutput(ctx("fail", { gates: { "denied-files": "fail" } }), opts());
    expect(out.systemMessage).toBe("blastcheck: ✗ FAIL — denied-files failed");
    expect(out.terminalSequence).toBeUndefined();
    // Default (passive) fail carries no feedback/block either.
    expect(out.hookSpecificOutput).toBeUndefined();
    expect(out.decision).toBeUndefined();
    expect(Object.keys(out)).toEqual(["systemMessage"]);
  });

  it("feedback opt-in: adds additionalContext on a fail; default off adds nothing", () => {
    const off = buildCodexStopOutput(ctx("fail"), opts());
    expect(off.hookSpecificOutput).toBeUndefined();

    const on = buildCodexStopOutput(ctx("fail"), opts({ feedback: true }));
    expect(on.hookSpecificOutput).toMatchObject({ hookEventName: "Stop" });
    expect((on.hookSpecificOutput as { additionalContext: string }).additionalContext).toContain(
      "blastcheck: ✗ FAIL",
    );
  });

  it("feedback opt-in adds additionalContext on a warn too", () => {
    const on = buildCodexStopOutput(
      ctx("warn", { findings: [{ severity: "warn", check: "churn", message: "x" }] }),
      opts({ feedback: true }),
    );
    expect((on.hookSpecificOutput as { additionalContext: string }).additionalContext).toContain(
      "blastcheck: ‼ warn",
    );
  });

  it("feedback opt-in does NOT fire on pass (pass stays a bare systemMessage)", () => {
    const out = buildCodexStopOutput(ctx("pass"), opts({ feedback: true }));
    expect(out).toEqual({ systemMessage: "blastcheck: ✓ pass — all clear" });
  });

  it("block opt-in: a fail emits decision:block + reason, and subsumes feedback", () => {
    const out = buildCodexStopOutput(ctx("fail"), opts({ block: true, feedback: true }));
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("blastcheck: ✗ FAIL");
    // block already feeds `reason` back — don't also duplicate via additionalContext.
    expect(out.hookSpecificOutput).toBeUndefined();
  });

  it("block does NOT apply to warn (warn never blocks)", () => {
    const out = buildCodexStopOutput(ctx("warn"), opts({ block: true }));
    expect(out.decision).toBeUndefined();
  });
});

describe("codexReporter.surface", () => {
  let stdout: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(() => vi.restoreAllMocks());

  it("writes the hook JSON to stdout and ALWAYS exits 0 (verdict rides in systemMessage)", async () => {
    const code = await codexReporter.surface(ctx("fail"), DEFAULT_SURFACING);
    expect(code).toBe(EXIT.OK);
    const written = stdout.mock.calls.map((c) => c[0]).join("");
    expect(JSON.parse(written).systemMessage).toContain("FAIL");
    expect(written.endsWith("\n")).toBe(true);
  });

  it("does NOT write the raw scorecard to stdout (only hook JSON)", async () => {
    await codexReporter.surface(ctx("pass"), DEFAULT_SURFACING);
    const written = stdout.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(written);
    expect(parsed.schema_version).toBeUndefined();
    expect(parsed.systemMessage).toBeDefined();
  });
});
