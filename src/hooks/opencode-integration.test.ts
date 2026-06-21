/**
 * End-to-end of the OpenCode hook CAPTURE lifecycle against a real temp git repo,
 * NO mocks of the audit core. Mirrors the Codex E2E (`codex-integration.test.ts`)
 * but is CAPTURE ONLY (Story 3.2): session-start → post-tool-use (bash + edit,
 * via the default adapter) → a committed in-scope change → assert the captured
 * trajectory loads cleanly and the baseline was pinned. It deliberately does NOT
 * call `runStop`/`runAudit` — the audit-on-idle/end trigger is Story 3.3.
 *
 * The native OpenCode `tool.execute.after` fixtures are mapped into the
 * Claude-compatible `PostToolUse` payload exactly as the generated plugin does,
 * so this drives the real native-event → forwarded-payload → handler path.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupRepo, commit, makeTempRepo } from "../../tests/fixtures/repos/make-repo.js";
import { loadTrajectory } from "../trajectory/loader.js";
import { runOpencodePostToolUse } from "./post-tool-use.js";
import { runSessionStart } from "./session-start.js";
import { baselinePath, readStateFile, trajectoryPath } from "./state.js";

const HOOK_FIXTURES = join(process.cwd(), "tests/fixtures/hooks");

interface ToolExecuteAfter {
  input: { tool?: string; [k: string]: unknown };
  output: { args?: unknown; output?: unknown; metadata?: Record<string, unknown> };
}

/** Same native → `PostToolUse` mapping the generated plugin applies. */
async function mappedFixture(name: string, cwd: string): Promise<Record<string, unknown>> {
  const sample = JSON.parse(await readFile(join(HOOK_FIXTURES, name), "utf8")) as ToolExecuteAfter;
  return {
    tool_name: sample.input.tool,
    tool_input: sample.output.args,
    tool_response: { ...(sample.output.metadata ?? {}), stdout: sample.output.output },
    cwd,
  };
}

describe("opencode hook lifecycle — capture end to end (no audit)", () => {
  let repo: string;

  beforeEach(() => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (repo) await cleanupRepo(repo);
  });

  it("captures an OpenCode trajectory and pins the baseline (capture only)", async () => {
    repo = await makeTempRepo();
    await commit(repo, { "README.md": "# repo\n" }, "init");

    // 1) OpenCode session start (the plugin forwards `{ source: "startup" }`) →
    //    record the pre-commitment reference and reset stale state.
    await runSessionStart({ source: "startup", cwd: repo }, repo);

    // 2) Agent declares its scope and commits it → this becomes the baseline the
    //    first post-tool-use event pins.
    await commit(repo, { "task.md": "---\nallow:\n  - src/**\n---\n# add feature\n" }, "pin scope");

    // 3) OpenCode tool.execute.after events: a bash command and a file edit,
    //    mapped exactly as the generated plugin maps them.
    await runOpencodePostToolUse(
      await mappedFixture("opencode-tool-execute-after.sample.json", repo),
      repo,
    );
    await runOpencodePostToolUse(
      await mappedFixture("opencode-tool-execute-after-edit.sample.json", repo),
      repo,
    );

    // 4) Agent makes its in-scope change (NOT audited here — capture only).
    await commit(repo, { "src/app.ts": "export const x = 1;\n" }, "implement");

    // The captured trajectory loads with zero diagnostics and both canonical
    // shapes are present (a `bash` command and an `edit` path).
    const result = await loadTrajectory(trajectoryPath(repo));
    expect(result.diagnostics).toEqual([]);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]?.args.cmd).toBe("npm test");
    expect(result.events[1]?.args.path).toBe("src/app.ts");

    // The baseline was pinned to the scope commit (pre-commitment recorded once).
    expect(await readStateFile(baselinePath(repo))).toBeDefined();
  });
});
