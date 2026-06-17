import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Scorecard } from "../scorecard/schema.js";

// runAudit is mocked: the Stop hook's job is wiring (baseline resolution, stdout
// contract, exit-code mapping, loop guard), not re-testing the audit itself.
const { runAuditMock } = vi.hoisted(() => ({ runAuditMock: vi.fn() }));
vi.mock("../index.js", () => ({ runAudit: runAuditMock }));

import { EXIT } from "../types.js";
import { baselinePath, scorecardPath, startHeadPath, writeStateFile } from "./state.js";
import { runStop } from "./stop.js";

function scorecard(verdict: Scorecard["verdict"]): Scorecard {
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
    stats: { files_changed: 0, lines_added: 0, lines_removed: 0, churn_pct: 0 },
  };
}

describe("stop hook", () => {
  let dir: string;
  let stdout: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    runAuditMock.mockReset();
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
});
