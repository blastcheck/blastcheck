/**
 * OpenCode hook-layer tests (Story 3.2): the OpenCode `post-tool-use` capture
 * path. CAPTURE ONLY — no `runStop`/audit (that is Story 3.3).
 *
 * The generated plugin (`src/integrations/opencode.ts`) shapes each native
 * `tool.execute.after` `(input, output)` event into the Claude-compatible
 * `PostToolUse` payload BEFORE it reaches the handler, so these tests apply that
 * same mapping to the doc-derived native fixtures and drive
 * `runOpencodePostToolUse` (which reuses the DEFAULT adapter — no OpenCode
 * `src/trajectory/` adapter) against a temp repo. `session-start` reuses the
 * agent-agnostic handler verbatim (its source semantics are already covered by
 * the Claude/Codex session-start tests), so it is exercised only in the E2E.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupRepo, commit, makeTempRepo } from "../../tests/fixtures/repos/make-repo.js";
import { loadTrajectory } from "../trajectory/loader.js";
import { runOpencodePostToolUse } from "./post-tool-use.js";
import { readStateFile, trajectoryPath } from "./state.js";

const HOOK_FIXTURES = join(process.cwd(), "tests/fixtures/hooks");

interface ToolExecuteAfter {
  input: { tool?: string; [k: string]: unknown };
  output: { args?: unknown; output?: unknown; metadata?: Record<string, unknown> };
}

/**
 * Mirror of the generated plugin's `tool.execute.after` → `PostToolUse` mapping
 * (`OPENCODE_PLUGIN_SOURCE` in `src/integrations/opencode.ts`). Kept in lockstep
 * with that plugin string so a native OpenCode fixture exercises the REAL capture
 * contract (native event → forwarded stdin payload → handler), not a hand-built
 * Claude payload. The plugin body lives inside a string constant and cannot be
 * imported, so the mapping is intentionally duplicated here.
 */
async function mappedFixture(name: string, cwd: string): Promise<Record<string, unknown>> {
  const sample = JSON.parse(await readFile(join(HOOK_FIXTURES, name), "utf8")) as ToolExecuteAfter;
  return {
    tool_name: sample.input.tool,
    tool_input: sample.output.args,
    tool_response: { ...(sample.output.metadata ?? {}), stdout: sample.output.output },
    cwd,
  };
}

describe("opencode post-tool-use hook (capture only)", () => {
  let repo: string;

  beforeEach(() => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (repo) await cleanupRepo(repo);
  });

  it("appends a loader-readable canonical line from a mapped bash event (AC2)", async () => {
    repo = await makeTempRepo();
    await commit(repo, { "task.md": "# goal\n" }, "init");

    await runOpencodePostToolUse(
      await mappedFixture("opencode-tool-execute-after.sample.json", repo),
      repo,
    );

    const result = await loadTrajectory(trajectoryPath(repo));
    expect(result.diagnostics).toEqual([]);
    expect(result.events).toHaveLength(1);
    // OpenCode's `bash` tool is already in SHELL_TOOLS, so the canonical line
    // carries `args.cmd` and the Bash security gate fires downstream.
    expect(result.events[0]?.tool).toBe("bash");
    expect(result.events[0]?.args.cmd).toBe("npm test");
  });

  it("captures an edit event as a canonical path line (AC2)", async () => {
    repo = await makeTempRepo();
    await commit(repo, { "task.md": "# goal\n" }, "init");

    await runOpencodePostToolUse(
      await mappedFixture("opencode-tool-execute-after-edit.sample.json", repo),
      repo,
    );

    const result = await loadTrajectory(trajectoryPath(repo));
    expect(result.diagnostics).toEqual([]);
    expect(result.events[0]?.args.path).toBe("src/app.ts");
  });

  it("does not write `step` into the trajectory line (loader derives order)", async () => {
    repo = await makeTempRepo();
    await commit(repo, { "task.md": "# goal\n" }, "init");

    await runOpencodePostToolUse(
      await mappedFixture("opencode-tool-execute-after.sample.json", repo),
      repo,
    );

    const raw = (await readStateFile(trajectoryPath(repo))) ?? "";
    for (const line of raw.split("\n").filter(Boolean)) {
      expect(JSON.parse(line)).not.toHaveProperty("step");
    }
  });

  it("never throws on a malformed payload and writes no line (NFR6/NFR18)", async () => {
    repo = await makeTempRepo();
    await commit(repo, { "task.md": "# goal\n" }, "init");

    await expect(
      runOpencodePostToolUse({ nonsense: true, cwd: repo }, repo),
    ).resolves.toBeUndefined();
    expect(await readStateFile(trajectoryPath(repo))).toBeUndefined();
  });
});
