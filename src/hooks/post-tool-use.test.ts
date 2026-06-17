import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupRepo, commit, makeTempRepo } from "../../tests/fixtures/repos/make-repo.js";
import { loadTrajectory } from "../trajectory/loader.js";
import { runPostToolUse } from "./post-tool-use.js";
import {
  baselinePath,
  readStateFile,
  startHeadPath,
  trajectoryPath,
  writeStateFile,
} from "./state.js";

/** A realistic Claude Code PostToolUse payload for a Read. */
function readPayload(file: string, cwd: string): Record<string, unknown> {
  return {
    hook_event_name: "PostToolUse",
    cwd,
    tool_name: "Read",
    tool_input: { file_path: file },
    tool_response: { filePath: file, content: "...", success: true },
  };
}

/** A realistic Claude Code PostToolUse payload for a Bash command. */
function bashPayload(cmd: string, cwd: string): Record<string, unknown> {
  return {
    hook_event_name: "PostToolUse",
    cwd,
    tool_name: "Bash",
    tool_input: { command: cmd },
    tool_response: { stdout: "ok", stderr: "", interrupted: false },
  };
}

describe("post-tool-use hook", () => {
  let repo: string;

  beforeEach(() => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (repo) await cleanupRepo(repo);
  });

  it("appends canonical lines that loadTrajectory reads without diagnostics", async () => {
    repo = await makeTempRepo();
    await commit(repo, { "task.md": "# goal\n" }, "init");

    await runPostToolUse(readPayload("./src/app.ts", repo), repo);
    await runPostToolUse(bashPayload("npm test", repo), repo);

    const result = await loadTrajectory(trajectoryPath(repo));
    expect(result.diagnostics).toEqual([]);
    expect(result.events).toHaveLength(2);
    // Order comes from line position (no `step` is written), not the adapter.
    expect(result.events.map((e) => e.tool)).toEqual(["Read", "Bash"]);
    expect(result.events.map((e) => e.step)).toEqual([1, 2]);
    expect(result.events[0]?.args.path).toBe("src/app.ts");
    expect(result.events[1]?.args.cmd).toBe("npm test");
  });

  it("does not write `step` into the trajectory line", async () => {
    repo = await makeTempRepo();
    await commit(repo, { "task.md": "# goal\n" }, "init");

    await runPostToolUse(readPayload("a.ts", repo), repo);
    await runPostToolUse(readPayload("b.ts", repo), repo);

    const raw = (await readStateFile(trajectoryPath(repo))) ?? "";
    for (const line of raw.split("\n").filter(Boolean)) {
      expect(JSON.parse(line)).not.toHaveProperty("step");
    }
  });

  it("pins the first session commit as the baseline, exactly once", async () => {
    repo = await makeTempRepo();
    const start = await commit(repo, { "task.md": "# goal\n" }, "init");
    await writeStateFile(startHeadPath(repo), start);

    // No new commit yet → no pin.
    await runPostToolUse(readPayload("a.ts", repo), repo);
    expect(await readStateFile(baselinePath(repo))).toBeUndefined();

    // Agent commits its declared scope → next tool pins THAT commit.
    const firstCommit = await commit(repo, { "task.md": "# goal\nallow: src\n" }, "pin scope");
    await runPostToolUse(readPayload("b.ts", repo), repo);
    expect(await readStateFile(baselinePath(repo))).toBe(firstCommit);

    // A later commit must NOT move the frozen baseline.
    await commit(repo, { "src/app.ts": "x" }, "work");
    await runPostToolUse(readPayload("c.ts", repo), repo);
    expect(await readStateFile(baselinePath(repo))).toBe(firstCommit);
  });

  it("never throws on an unrecognized payload and writes nothing", async () => {
    repo = await makeTempRepo();
    await commit(repo, { "task.md": "# goal\n" }, "init");

    await expect(runPostToolUse({ nonsense: true }, repo)).resolves.toBeUndefined();
    expect(await readStateFile(trajectoryPath(repo))).toBeUndefined();
  });
});
