import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Scorecard } from "../scorecard/schema.js";

// runAudit is mocked: the Stop hook's job is wiring (baseline resolution, stdout
// contract, exit-code mapping, loop guard), not re-testing the audit itself.
// worktreeSignature AND trajectorySignature are mocked too so the snapshot-dedup
// gate is deterministic without a real git repo (the tmp dirs are not repos). The
// module-level mock replaces the WHOLE ./git.js module, so every export the hook
// imports must be stubbed here or it would read as `undefined` at runtime.
const { runAuditMock, worktreeSignatureMock, trajectorySignatureMock } = vi.hoisted(() => ({
  runAuditMock: vi.fn(),
  worktreeSignatureMock: vi.fn(),
  trajectorySignatureMock: vi.fn(),
}));
vi.mock("../index.js", () => ({ runAudit: runAuditMock }));
vi.mock("./git.js", () => ({
  worktreeSignature: worktreeSignatureMock,
  trajectorySignature: trajectorySignatureMock,
}));

// The composite snapshot marker is `head_sha:worktree-sig:trajectory-sig`. With the
// mocks below it is deterministic; pin it as a named constant so the three marker
// assertions read as intent, not magic strings.
const TRAJ_SIG = "traj";
const MARKER = `head:sig:${TRAJ_SIG}`;

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

// `filesChanged` no longer gates surfacing (the FR2 empty-diff silencer was removed
// in Story 1.2 — dedup is snapshot-equality, not a mutation count). It only shapes
// the audited diff; pass 0 to model a zero-change `empty` turn.
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
    trajectorySignatureMock.mockReset();
    trajectorySignatureMock.mockResolvedValue(TRAJ_SIG);
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

  describe("snapshot-dedup (Story 1.2)", () => {
    // AC #1/#2/#3: the FR2 empty-diff silencer is GONE. The first sighting of a
    // zero-change turn now surfaces (an interim `empty` line) and writes the marker;
    // dedup is snapshot-equality, never a mutation count.
    it("surfaces the first empty turn (files_changed === 0) and writes the marker", async () => {
      await writeStateFile(baselinePath(dir), "sha");
      runAuditMock.mockResolvedValue(scorecard("warn", 0));
      const reporter = spyReporter();

      const code = await runStop({ cwd: dir }, dir, reporter);

      expect(code).toBe(EXIT.OK);
      // First sighting of this snapshot → it surfaces, even with zero changed files.
      expect(reporter.surface).toHaveBeenCalledTimes(1);
      // Source of truth is still durable (NFR6).
      expect(JSON.parse(await readFile(scorecardPath(dir), "utf8"))).toMatchObject({
        verdict: "warn",
      });
      // A successful surface records the snapshot marker.
      expect(await readFile(lastSurfacedPath(dir), "utf8")).toBe(MARKER);
    });

    // AC #2/#3: once the first empty turn has surfaced, an IDENTICAL empty repeat
    // (same diff, same trajectory) is silenced — the snapshot was already emitted.
    it("silences an identical empty repeat after the first empty surfaces", async () => {
      await writeStateFile(baselinePath(dir), "sha");
      runAuditMock.mockResolvedValue(scorecard("warn", 0));
      const reporter = spyReporter();

      expect(await runStop({ cwd: dir }, dir, reporter)).toBe(EXIT.OK);
      expect(await runStop({ cwd: dir }, dir, reporter)).toBe(EXIT.OK);

      // First empty surfaces; the second, unchanged empty is deduped.
      expect(reporter.surface).toHaveBeenCalledTimes(1);
      expect(await readFile(lastSurfacedPath(dir), "utf8")).toBe(MARKER);
    });

    it("surfaces once, then silences an unchanged second turn", async () => {
      await writeStateFile(baselinePath(dir), "sha");
      runAuditMock.mockResolvedValue(scorecard("warn"));
      const reporter = spyReporter();

      expect(await runStop({ cwd: dir }, dir, reporter)).toBe(EXIT.OK);
      expect(await runStop({ cwd: dir }, dir, reporter)).toBe(EXIT.OK);

      // Same head_sha + worktree sig + trajectory sig → the second turn is deduped.
      expect(reporter.surface).toHaveBeenCalledTimes(1);
      expect(await readFile(lastSurfacedPath(dir), "utf8")).toBe(MARKER);
    });

    // AC #4: same diff, but the trajectory grows between turns (new tool-calls,
    // no file change) → the composite signature changes → the second turn is a NEW
    // snapshot and surfaces, rather than being mistaken for an idle repeat.
    it("surfaces again when the trajectory grows despite an unchanged diff", async () => {
      await writeStateFile(baselinePath(dir), "sha");
      runAuditMock.mockResolvedValue(scorecard("warn"));
      // Worktree signature is steady ("sig"); only the trajectory position moves.
      trajectorySignatureMock.mockResolvedValueOnce("traj-1").mockResolvedValueOnce("traj-2");
      const reporter = spyReporter();

      expect(await runStop({ cwd: dir }, dir, reporter)).toBe(EXIT.OK);
      expect(await runStop({ cwd: dir }, dir, reporter)).toBe(EXIT.OK);

      // Different trajectory sig → different snapshot → both surface.
      expect(reporter.surface).toHaveBeenCalledTimes(2);
      // The marker tracks the most recent snapshot.
      expect(await readFile(lastSurfacedPath(dir), "utf8")).toBe("head:sig:traj-2");
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
      expect(await readFile(lastSurfacedPath(dir), "utf8")).toBe(MARKER);
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

    // An UNREADABLE (not merely absent) trajectory is "cannot tell" too:
    // `trajectorySignature` returns undefined, so — exactly like git-down — the
    // turn surfaces and writes no marker, never folding an unreadable trajectory
    // into a dedup that could falsely silence a real change (code review 2026-06-30).
    it("does not dedup when the trajectory signature is unavailable (unreadable)", async () => {
      await writeStateFile(baselinePath(dir), "sha");
      runAuditMock.mockResolvedValue(scorecard("warn"));
      // Worktree is fine; only the trajectory half cannot be read.
      trajectorySignatureMock.mockResolvedValue(undefined);
      const reporter = spyReporter();

      await runStop({ cwd: dir }, dir, reporter);
      await runStop({ cwd: dir }, dir, reporter);

      expect(reporter.surface).toHaveBeenCalledTimes(2);
      await expect(readFile(lastSurfacedPath(dir), "utf8")).rejects.toThrow();
    });

    // Story 1.3 ↔ 1.1: a gate-fail surface goes through the SAME dedup gate. It fires
    // once per state change, then the unchanged next turn is silent. (Story 1.3 removed
    // the `decision:"block"` push; the gate-fail now surfaces via `systemMessage` only,
    // but the once-then-silent dedup behavior is unchanged — it never keyed on `decision`.)
    it("gate-fail surface fires once via the real reporter, then the unchanged turn is silent", async () => {
      await writeStateFile(baselinePath(dir), "sha");
      const gateFail: Scorecard = { ...scorecard("fail"), gates: { "denied-files": "fail" } };
      runAuditMock.mockResolvedValue(gateFail);

      // First turn: the gate-fail surfaces via systemMessage on exit 0 (no decision/block).
      expect(await runStop({ cwd: dir }, dir, claudeCodeReporter)).toBe(EXIT.OK);
      const firstWrite = stdout.mock.calls.map((c) => c[0]).join("");
      const firstOut = JSON.parse(firstWrite);
      expect(firstOut.decision).toBeUndefined();
      expect(firstOut.systemMessage).toContain("FAIL");
      // The successful surface wrote the marker (gate-fail still returns EXIT.OK).
      expect(await readFile(lastSurfacedPath(dir), "utf8")).toBe(MARKER);

      // Second turn, same snapshot signature → dedup silences the repeat block.
      const writesBefore = stdout.mock.calls.length;
      const auditsBefore = runAuditMock.mock.calls.length;
      expect(await runStop({ cwd: dir }, dir, claudeCodeReporter)).toBe(EXIT.OK);
      // Pin that the silence is the DEDUP path, not an unrelated early-return: turn 2
      // must run the audit (so it reached past the baseline check to the last-surfaced
      // compare) AND still emit nothing. Without the audit assertion, a regression
      // that bailed before surfacing for any reason would pass this test.
      expect(runAuditMock.mock.calls.length).toBe(auditsBefore + 1);
      expect(stdout.mock.calls.length).toBe(writesBefore); // no second surface
    });
  });
});
