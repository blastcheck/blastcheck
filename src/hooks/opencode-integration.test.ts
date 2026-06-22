/**
 * End-to-end of the OpenCode hook lifecycle against a real temp git repo, NO mocks
 * of the audit core. Mirrors the Codex E2E (`codex-integration.test.ts`):
 * session-start → post-tool-use (bash + edit, via the default adapter) → a
 * committed in-scope change → stop (real `runStop`/`runAudit`). The captured
 * OpenCode trajectory must actually be consumed by the audit
 * (`evidence_level.trajectory === "present"`), the scorecard lands on stdout and is
 * mirrored to disk (Story 3.3 audit-on-idle trigger). A second case proves honest
 * degradation: a stop with NO captured trajectory still audits and does not report
 * a `present` trajectory (AC4).
 *
 * The native OpenCode `tool.execute.after` fixtures are mapped into the
 * Claude-compatible `PostToolUse` payload exactly as the generated plugin does,
 * so this drives the real native-event → forwarded-payload → handler path.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupRepo, commit, makeTempRepo } from "../../tests/fixtures/repos/make-repo.js";
import type { Scorecard } from "../scorecard/schema.js";
import { loadTrajectory } from "../trajectory/loader.js";
import { EXIT } from "../types.js";
import { runOpencodePostToolUse } from "./post-tool-use.js";
import { runSessionStart } from "./session-start.js";
import { baselinePath, readStateFile, scorecardPath, trajectoryPath } from "./state.js";
import { runStop } from "./stop.js";

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

describe("opencode hook lifecycle — capture + audit end to end", () => {
  let repo: string;
  let stdout: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // The scorecard goes to stdout on stop — spy it (the 3.2 capture-only test
    // spied only stderr; the audit step requires the stdout spy too).
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (repo) await cleanupRepo(repo);
  });

  it("captures an OpenCode trajectory, pins the baseline, and audits on session idle", async () => {
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

    // 4) Agent makes its in-scope change.
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

    // 5) session.idle → run the audit through the SAME runStop/runAudit path the
    //    plugin's `forward("stop", {})` shell-out reaches via `hook opencode stop`.
    const code = await runStop({ cwd: repo }, repo);

    expect(code).not.toBe(EXIT.TOOL_ERROR);

    const written = stdout.mock.calls.map((c) => c[0]).join("");
    const scorecard = JSON.parse(written) as Scorecard;
    expect(scorecard.schema_version).toBeDefined();
    expect(["pass", "warn", "fail"]).toContain(scorecard.verdict);
    // The OpenCode trajectory we captured was actually consumed by the audit.
    expect(scorecard.evidence_level.trajectory).toBe("present");

    // And the scorecard is mirrored to disk.
    const mirror = JSON.parse(await readFile(scorecardPath(repo), "utf8")) as Scorecard;
    expect(mirror.verdict).toBe(scorecard.verdict);
  });

  it("audits honestly on stop when no OpenCode trajectory was captured (AC4)", async () => {
    repo = await makeTempRepo();
    await commit(repo, { "README.md": "# repo\n" }, "init");

    // Session start pins a start_head, then a committed change gives stop a real
    // baseline — but NO post-tool-use events run, so there is no trajectory.
    await runSessionStart({ source: "startup", cwd: repo }, repo);
    await commit(repo, { "task.md": "---\nallow:\n  - src/**\n---\n# add feature\n" }, "pin scope");
    await commit(repo, { "src/app.ts": "export const x = 1;\n" }, "implement");

    const code = await runStop({ cwd: repo }, repo);

    // It still audits (not a tool error) and degrades honestly: with no usable
    // trajectory the evidence level is NOT `present` — no fabricated signal.
    expect(code).not.toBe(EXIT.TOOL_ERROR);
    const written = stdout.mock.calls.map((c) => c[0]).join("");
    const scorecard = JSON.parse(written) as Scorecard;
    expect(scorecard.evidence_level.trajectory).not.toBe("present");
  });
});
