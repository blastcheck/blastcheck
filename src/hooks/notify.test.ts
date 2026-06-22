import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { desktopAlertMock } = vi.hoisted(() => ({ desktopAlertMock: vi.fn() }));
vi.mock("../reporters/desktop-alert.js", () => ({ desktopAlert: desktopAlertMock }));

import { runCodexNotify } from "./notify.js";

/** Write a minimal scorecard mirror with `verdict` into `${dir}/.blastcheck/`. */
async function writeScorecard(dir: string, verdict: string): Promise<void> {
  await mkdir(join(dir, ".blastcheck"), { recursive: true });
  await writeFile(
    join(dir, ".blastcheck", "scorecard.json"),
    JSON.stringify({
      schema_version: "1",
      run_id: "r",
      agent: "codex",
      baseline_sha: "b",
      head_sha: "h",
      task_goal: null,
      verdict,
      evidence_level: { trajectory: "present", checks: {} },
      gates: verdict === "fail" ? { "denied-files": "fail" } : {},
      scores: {},
      findings: [],
      stats: { files_changed: 1, lines_added: 1, lines_removed: 0, churn_pct: 0 },
    }),
    "utf8",
  );
}

describe("runCodexNotify", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "blastcheck-notify-"));
  });

  afterEach(async () => {
    desktopAlertMock.mockReset();
    await rm(dir, { recursive: true, force: true });
  });

  it("fail scorecard → raises exactly one desktop alert carrying the headline", async () => {
    await writeScorecard(dir, "fail");
    await runCodexNotify(JSON.stringify({ type: "agent-turn-complete", cwd: dir }));
    expect(desktopAlertMock).toHaveBeenCalledTimes(1);
    expect(desktopAlertMock.mock.calls[0][0]).toContain("blastcheck: ✗ FAIL");
  });

  it("pass scorecard → no alert", async () => {
    await writeScorecard(dir, "pass");
    await runCodexNotify(JSON.stringify({ cwd: dir }));
    expect(desktopAlertMock).not.toHaveBeenCalled();
  });

  it("warn scorecard → no alert (alert is fail-only)", async () => {
    await writeScorecard(dir, "warn");
    await runCodexNotify(JSON.stringify({ cwd: dir }));
    expect(desktopAlertMock).not.toHaveBeenCalled();
  });

  it("missing scorecard (the common cross-project case) → no alert, no throw", async () => {
    await expect(runCodexNotify(JSON.stringify({ cwd: dir }))).resolves.toBeUndefined();
    expect(desktopAlertMock).not.toHaveBeenCalled();
  });

  it("payload with no cwd → no alert, no throw", async () => {
    await writeScorecard(dir, "fail");
    await runCodexNotify(JSON.stringify({ type: "agent-turn-complete" }));
    expect(desktopAlertMock).not.toHaveBeenCalled();
  });

  it("malformed payload JSON → no alert, no throw", async () => {
    await expect(runCodexNotify("{ not json")).resolves.toBeUndefined();
    expect(desktopAlertMock).not.toHaveBeenCalled();
  });

  it("undefined payload (defensive) → no alert, no throw", async () => {
    await expect(runCodexNotify(undefined)).resolves.toBeUndefined();
    expect(desktopAlertMock).not.toHaveBeenCalled();
  });

  it("corrupt scorecard mirror → no alert, no throw", async () => {
    await mkdir(join(dir, ".blastcheck"), { recursive: true });
    await writeFile(join(dir, ".blastcheck", "scorecard.json"), "{ corrupt", "utf8");
    await expect(runCodexNotify(JSON.stringify({ cwd: dir }))).resolves.toBeUndefined();
    expect(desktopAlertMock).not.toHaveBeenCalled();
  });

  it("malformed fail scorecard (verdict:fail, missing gates/findings) → no throw, no alert", async () => {
    // A partial/interrupted/hand-edited mirror: passes the `verdict==="fail"`
    // guard but would make `verdictHeadline` dereference an absent `gates`.
    // The render is guarded, so the notify program must still degrade quietly.
    await mkdir(join(dir, ".blastcheck"), { recursive: true });
    await writeFile(
      join(dir, ".blastcheck", "scorecard.json"),
      JSON.stringify({ verdict: "fail" }),
      "utf8",
    );
    await expect(runCodexNotify(JSON.stringify({ cwd: dir }))).resolves.toBeUndefined();
    expect(desktopAlertMock).not.toHaveBeenCalled();
  });
});
