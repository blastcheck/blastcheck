import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Scorecard } from "../scorecard/schema.js";
import { EXIT } from "../types.js";

// Mock the shared desktop-alert helper so the fail-alert assertion never fires a
// real OS notification in CI (mirrors notify.test.ts).
const { desktopAlertMock } = vi.hoisted(() => ({ desktopAlertMock: vi.fn() }));
vi.mock("./desktop-alert.js", () => ({ desktopAlert: desktopAlertMock }));

import { buildOpencodeSurface, opencodeReporter } from "./opencode.js";
import { DEFAULT_SURFACING, type SurfacingOptions } from "./types.js";

function scorecard(verdict: Scorecard["verdict"], overrides: Partial<Scorecard> = {}): Scorecard {
  return {
    schema_version: "1",
    run_id: "test-run",
    agent: "opencode",
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

describe("buildOpencodeSurface", () => {
  it("pass: a brief visible line via message, variant success, no feedback", () => {
    const surface = buildOpencodeSurface(ctx("pass"), opts());
    expect(surface).toEqual({
      message: "blastcheck: ✓ pass — 1 files changed, scope ok",
      variant: "success",
    });
    expect(surface.feedback).toBeUndefined();
  });

  it("warn: variant warning, no feedback unless opt-in", () => {
    const surface = buildOpencodeSurface(
      ctx("warn", { findings: [{ severity: "warn", check: "churn", message: "x" }] }),
      opts(),
    );
    expect(surface.message).toBe("blastcheck: ‼ warn — 1 warn · 1 files, churn 0.0%");
    expect(surface.variant).toBe("warning");
    expect(surface.feedback).toBeUndefined();
  });

  it("fail: variant error, no feedback by default", () => {
    const surface = buildOpencodeSurface(
      ctx("fail", { gates: { "denied-files": "fail" } }),
      opts(),
    );
    expect(surface.message).toBe("blastcheck: ✗ FAIL — denied-files failed · 1 files, churn 0.0%");
    expect(surface.variant).toBe("error");
    expect(surface.feedback).toBeUndefined();
    expect(Object.keys(surface)).toEqual(["message", "variant"]);
  });

  it("feedback opt-in: adds verdictDetail on a fail; default off adds nothing", () => {
    const sc = { gates: { "denied-files": "fail" } } as const;
    const off = buildOpencodeSurface(ctx("fail", sc), opts());
    expect(off.feedback).toBeUndefined();

    const on = buildOpencodeSurface(ctx("fail", sc), opts({ feedback: true }));
    expect(on.feedback).toContain("blastcheck: ✗ FAIL");
    // It is the shared verdictDetail block (multi-line, points at the scorecard).
    expect(on.feedback).toContain("full scorecard: .blastcheck/scorecard.json");
  });

  it("feedback opt-in adds detail on a warn too", () => {
    const on = buildOpencodeSurface(
      ctx("warn", { findings: [{ severity: "warn", check: "churn", message: "x" }] }),
      opts({ feedback: true }),
    );
    expect(on.feedback).toContain("blastcheck: ‼ warn");
  });

  it("feedback opt-in does NOT fire on pass (pass stays a bare toast)", () => {
    const surface = buildOpencodeSurface(ctx("pass"), opts({ feedback: true }));
    expect(surface).toEqual({
      message: "blastcheck: ✓ pass — 1 files changed, scope ok",
      variant: "success",
    });
  });

  it("block is a no-op for OpenCode v1 (never blocks, never adds fields)", () => {
    const surface = buildOpencodeSurface(
      ctx("fail", { gates: { "denied-files": "fail" } }),
      opts({ block: true }),
    );
    expect(surface.feedback).toBeUndefined();
    expect(Object.keys(surface)).toEqual(["message", "variant"]);
  });
});

describe("opencodeReporter.surface", () => {
  let stdout: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    desktopAlertMock.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("writes the surface JSON line to stdout and ALWAYS exits 0", async () => {
    const code = await opencodeReporter.surface(
      ctx("fail", { gates: { "denied-files": "fail" } }),
      DEFAULT_SURFACING,
    );
    expect(code).toBe(EXIT.OK);
    const written = stdout.mock.calls.map((c) => c[0]).join("");
    expect(JSON.parse(written).message).toContain("FAIL");
    expect(written.endsWith("\n")).toBe(true);
  });

  it("does NOT write the raw scorecard to stdout (only the surface object)", async () => {
    await opencodeReporter.surface(ctx("pass"), DEFAULT_SURFACING);
    const written = stdout.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(written);
    expect(parsed.schema_version).toBeUndefined();
    expect(parsed.message).toBeDefined();
    expect(parsed.variant).toBe("success");
  });

  it("fires the desktop alert exactly once on a fail (with the headline)", async () => {
    await opencodeReporter.surface(
      ctx("fail", { gates: { "denied-files": "fail" } }),
      DEFAULT_SURFACING,
    );
    expect(desktopAlertMock).toHaveBeenCalledTimes(1);
    expect(desktopAlertMock.mock.calls[0][0]).toContain("blastcheck: ✗ FAIL");
  });

  it("does NOT fire the desktop alert on pass or warn", async () => {
    await opencodeReporter.surface(ctx("pass"), DEFAULT_SURFACING);
    await opencodeReporter.surface(ctx("warn"), DEFAULT_SURFACING);
    expect(desktopAlertMock).not.toHaveBeenCalled();
  });
});
