import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Scorecard } from "../scorecard/schema.js";

// runAudit is mocked: the Stop hook's job is wiring (baseline resolution, stdout
// contract, exit-code mapping, loop guard), not re-testing the audit itself.
// worktreeSignature is mocked too so the state-dedup gate is deterministic
// without a real git repo (the tmp dirs are not repos).
const { runAuditMock, worktreeSignatureMock } = vi.hoisted(() => ({
  runAuditMock: vi.fn(),
  worktreeSignatureMock: vi.fn(),
}));
vi.mock("../index.js", () => ({ runAudit: runAuditMock }));
vi.mock("./git.js", () => ({ worktreeSignature: worktreeSignatureMock }));

import { claudeCodeReporter } from "../reporters/claude-code.js";
import type { Reporter } from "../reporters/types.js";
import { EXIT, type ExitCode } from "../types.js";
import {
  baselinePath,
  lastSurfacedPath,
  scorecardPath,
  startHeadPath,
  writeStateFile,
} from "./state.js";
import { runStop } from "./stop.js";

// Default fixture has files_changed > 0 so it reaches the reporter under the FR2
// gate; pass 0 explicitly to exercise empty-diff silence.
function scorecard(verdict: Scorecard["verdict"], filesChanged = 1): Scorecard {
  return {
    schema_version: "1",
    run_id: "test-run",
    agent: null,
    baseline_sha: "base",
    head_sha: "head",
    task_goal: null,
    verdict,
    evidence_level: { trajectory: "absent", checks: {} },
    gates: {},
    scores: {},
    findings: [],
    stats: { files_changed: filesChanged, lines_added: 0, lines_removed: 0, churn_pct: 0 },
  };
}

/** A reporter spy that records calls and returns a fixed exit code. */
function spyReporter(exit: ExitCode = EXIT.OK): Reporter & { surface: ReturnType<typeof vi.fn> } {
  return { surface: vi.fn().mockResolvedValue(exit) };
}

describe("stop hook", () => {
  let dir: string;
  let stdout: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    runAuditMock.mockReset();
    worktreeSignatureMock.mockReset();
    worktreeSignatureMock.mockResolvedValue("sig");
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    dir = await mkdtemp(join(tmpdir(), "blastcheck-stop-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("audits against the pinned baseline and emits scorecard.json to stdout", async () => {
    await writeStateFile(baselinePath(dir), "pinnedsha");
    runAuditMock.mockResolvedValue(scorecard("pass"));

    const code = await runStop({ stop_hook_active: false, cwd: dir }, dir);

    expect(code).toBe(EXIT.OK);
    expect(runAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: dir, baselineSha: "pinnedsha" }),
    );
    // stdout receives exactly the scorecard JSON.
    const written = stdout.mock.calls.map((c) => c[0]).join("");
    expect(JSON.parse(written)).toMatchObject({ verdict: "pass" });
    // ...and it is mirrored to disk.
    expect(JSON.parse(await readFile(scorecardPath(dir), "utf8"))).toMatchObject({
      verdict: "pass",
    });
  });

  it("maps a fail verdict to exit code 1", async () => {
    await writeStateFile(baselinePath(dir), "sha");
    runAuditMock.mockResolvedValue(scorecard("fail"));

    expect(await runStop({ cwd: dir }, dir)).toBe(EXIT.FAIL);
  });

  it("warn never blocks — exit code 0", async () => {
    await writeStateFile(baselinePath(dir), "sha");
    runAuditMock.mockResolvedValue(scorecard("warn"));

    expect(await runStop({ cwd: dir }, dir)).toBe(EXIT.OK);
  });

  it("falls back to start_head when no commit was pinned", async () => {
    await writeStateFile(startHeadPath(dir), "starthead");
    runAuditMock.mockResolvedValue(scorecard("pass"));

    await runStop({ cwd: dir }, dir);
    expect(runAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ baselineSha: "starthead" }),
    );
  });

  it("returns a tool error (exit 2) when no baseline can be resolved", async () => {
    expect(await runStop({ cwd: dir }, dir)).toBe(EXIT.TOOL_ERROR);
    expect(runAuditMock).not.toHaveBeenCalled();
  });

  it("returns a tool error (exit 2) when runAudit throws", async () => {
    await writeStateFile(baselinePath(dir), "sha");
    runAuditMock.mockRejectedValue(new Error("no git repo"));

    expect(await runStop({ cwd: dir }, dir)).toBe(EXIT.TOOL_ERROR);
  });

  it("skips re-auditing when stop_hook_active is true (loop guard)", async () => {
    await writeStateFile(baselinePath(dir), "sha");

    expect(await runStop({ stop_hook_active: true, cwd: dir }, dir)).toBe(EXIT.OK);
    expect(runAuditMock).not.toHaveBeenCalled();
  });

  describe("state-dedup (Story 1.1)", () => {
    it("silences an empty diff (files_changed === 0) but still mirrors scorecard.json", async () => {
      await writeStateFile(baselinePath(dir), "sha");
      runAuditMock.mockResolvedValue(scorecard("warn", 0));
      const reporter = spyReporter();

      const code = await runStop({ cwd: dir }, dir, reporter);

      expect(code).toBe(EXIT.OK);
      expect(reporter.surface).not.toHaveBeenCalled();
      // Source of truth is still durable (NFR6).
      expect(JSON.parse(await readFile(scorecardPath(dir), "utf8"))).toMatchObject({
        verdict: "warn",
      });
      // No state was surfaced → no marker written.
      await expect(readFile(lastSurfacedPath(dir), "utf8")).rejects.toThrow();
    });

    it("surfaces once, then silences an unchanged second turn", async () => {
      await writeStateFile(baselinePath(dir), "sha");
      runAuditMock.mockResolvedValue(scorecard("warn"));
      const reporter = spyReporter();

      expect(await runStop({ cwd: dir }, dir, reporter)).toBe(EXIT.OK);
      expect(await runStop({ cwd: dir }, dir, reporter)).toBe(EXIT.OK);

      // Same head_sha + signature → the second turn is deduped.
      expect(reporter.surface).toHaveBeenCalledTimes(1);
      expect(await readFile(lastSurfacedPath(dir), "utf8")).toBe("head:sig");
    });

    it("does not write the marker when surface throws (next turn re-surfaces)", async () => {
      await writeStateFile(baselinePath(dir), "sha");
      runAuditMock.mockResolvedValue(scorecard("pass"));
      const reporter: Reporter = {
        surface: vi
          .fn()
          .mockRejectedValueOnce(new Error("channel down"))
          .mockResolvedValue(EXIT.OK),
      };

      await runStop({ cwd: dir }, dir, reporter);
      // A failed surface left no marker behind.
      await expect(readFile(lastSurfacedPath(dir), "utf8")).rejects.toThrow();

      // So the next turn surfaces again rather than going silent.
      await runStop({ cwd: dir }, dir, reporter);
      expect(reporter.surface).toHaveBeenCalledTimes(2);
    });

    it("surfaces (and writes a marker) when no prior marker exists", async () => {
      await writeStateFile(baselinePath(dir), "sha");
      runAuditMock.mockResolvedValue(scorecard("warn"));
      const reporter = spyReporter();

      await runStop({ cwd: dir }, dir, reporter);

      expect(reporter.surface).toHaveBeenCalledTimes(1);
      expect(await readFile(lastSurfacedPath(dir), "utf8")).toBe("head:sig");
    });

    it("does not dedup when the worktree signature is unavailable (git down)", async () => {
      await writeStateFile(baselinePath(dir), "sha");
      runAuditMock.mockResolvedValue(scorecard("warn"));
      worktreeSignatureMock.mockResolvedValue(undefined);
      const reporter = spyReporter();

      // Both turns surface: ambiguity resolves toward surfacing, never false silence.
      await runStop({ cwd: dir }, dir, reporter);
      await runStop({ cwd: dir }, dir, reporter);

      expect(reporter.surface).toHaveBeenCalledTimes(2);
      // No reliable state → no marker recorded.
      await expect(readFile(lastSurfacedPath(dir), "utf8")).rejects.toThrow();
    });

    // Story 1.3 ↔ 1.1: the gate-fail PUSH (decision:"block") goes through the SAME
    // dedup gate. It fires once per state change, then the unchanged next turn is
    // silent — so the forced continuation can never become a Stop→block loop (NFR1).
    it("gate-fail push fires once via the real reporter, then the unchanged turn is silent", async () => {
      await writeStateFile(baselinePath(dir), "sha");
      const gateFail: Scorecard = { ...scorecard("fail"), gates: { "denied-files": "fail" } };
      runAuditMock.mockResolvedValue(gateFail);

      // First turn: the push surfaces — decision:"block" rides the hook JSON on exit 0.
      expect(await runStop({ cwd: dir }, dir, claudeCodeReporter)).toBe(EXIT.OK);
      const firstWrite = stdout.mock.calls.map((c) => c[0]).join("");
      expect(JSON.parse(firstWrite).decision).toBe("block");
      // The successful surface wrote the marker (gate-fail still returns EXIT.OK).
      expect(await readFile(lastSurfacedPath(dir), "utf8")).toBe("head:sig");

      // Second turn, same head_sha + signature → dedup silences the repeat block.
      const writesBefore = stdout.mock.calls.length;
      const auditsBefore = runAuditMock.mock.calls.length;
      expect(await runStop({ cwd: dir }, dir, claudeCodeReporter)).toBe(EXIT.OK);
      // Pin that the silence is the DEDUP path, not an unrelated early-return: turn 2
      // must run the audit (so it reached past the baseline/empty-diff checks to the
      // last-surfaced compare) AND still emit nothing. Without the audit assertion, a
      // regression that bailed before surfacing for any reason would pass this test.
      expect(runAuditMock.mock.calls.length).toBe(auditsBefore + 1);
      expect(stdout.mock.calls.length).toBe(writesBefore); // no second surface
    });
  });
});
