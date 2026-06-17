/**
 * End-to-end of the hook layer against a real temp git repo, NO mocks: the full
 * session shape — session-start → post-tool-use (record + pin) → stop (real
 * runAudit) — produces a valid scorecard whose evidence includes the trajectory.
 */

import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupRepo, commit, makeTempRepo } from "../../tests/fixtures/repos/make-repo.js";
import type { Scorecard } from "../scorecard/schema.js";
import { EXIT } from "../types.js";
import { runPostToolUse } from "./post-tool-use.js";
import { runSessionStart } from "./session-start.js";
import { scorecardPath } from "./state.js";
import { runStop } from "./stop.js";

describe("hook layer — end to end", () => {
  let repo: string;
  let stdout: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (repo) await cleanupRepo(repo);
  });

  it("records a trajectory, pins the baseline, and audits on Stop", async () => {
    repo = await makeTempRepo();
    // The agent's pre-run state (task.md not yet declared).
    await commit(repo, { "README.md": "# repo\n" }, "init");

    // 1) Session starts: capture the pre-commitment reference.
    await runSessionStart({ source: "startup", cwd: repo }, repo);

    // 2) Agent declares its scope and commits it → this is the baseline.
    await commit(repo, { "task.md": "---\nallow:\n  - src/**\n---\n# add feature\n" }, "pin scope");

    // 3) Tools run; each PostToolUse records an event and pins the baseline once.
    await runPostToolUse(
      { tool_name: "Read", tool_input: { file_path: "src/app.ts" }, cwd: repo },
      repo,
    );
    await runPostToolUse(
      {
        tool_name: "Bash",
        tool_input: { command: "npm test" },
        tool_response: { stdout: "ok" },
        cwd: repo,
      },
      repo,
    );

    // 4) Agent makes its change.
    await commit(repo, { "src/app.ts": "export const x = 1;\n" }, "implement");

    // 5) Session stops: run the audit through the same runAudit path.
    const code = await runStop({ stop_hook_active: false, cwd: repo }, repo);

    // A clean in-scope change → not a failure.
    expect(code).not.toBe(EXIT.TOOL_ERROR);

    const written = stdout.mock.calls.map((c) => c[0]).join("");
    const scorecard = JSON.parse(written) as Scorecard;
    expect(scorecard.schema_version).toBeDefined();
    expect(["pass", "warn", "fail"]).toContain(scorecard.verdict);
    // The trajectory we recorded was actually consumed.
    expect(scorecard.evidence_level.trajectory).toBe("present");

    // And the scorecard is mirrored to disk.
    const mirror = JSON.parse(await readFile(scorecardPath(repo), "utf8")) as Scorecard;
    expect(mirror.verdict).toBe(scorecard.verdict);
  });
});
