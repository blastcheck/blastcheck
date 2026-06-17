import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupRepo,
  commit,
  makeNonRepoDir,
  makeTempRepo,
} from "../../tests/fixtures/repos/make-repo.js";
import { runSessionStart } from "./session-start.js";
import { baselinePath, startHeadPath, trajectoryPath, writeStateFile } from "./state.js";

describe("session-start hook", () => {
  let repo: string;

  beforeEach(() => {
    // Keep the test log clean; hooks log to stderr.
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (repo) await cleanupRepo(repo);
  });

  it("records the current HEAD as the pre-commitment start reference", async () => {
    repo = await makeTempRepo();
    const sha = await commit(repo, { "task.md": "# goal\n" }, "init");

    await runSessionStart({ source: "startup", cwd: repo }, repo);

    expect(await readFile(startHeadPath(repo), "utf8")).toBe(sha);
  });

  it("resets trajectory and stale baseline on a fresh (startup) session", async () => {
    repo = await makeTempRepo();
    await commit(repo, { "task.md": "# goal\n" }, "init");
    await writeStateFile(trajectoryPath(repo), '{"tool":"Read","args":{"path":"old.ts"}}\n');
    await writeStateFile(baselinePath(repo), "deadbeef");

    await runSessionStart({ source: "startup", cwd: repo }, repo);

    expect(await readFile(trajectoryPath(repo), "utf8")).toBe("");
    await expect(readFile(baselinePath(repo), "utf8")).rejects.toThrow();
  });

  it("preserves trajectory and baseline on resume", async () => {
    repo = await makeTempRepo();
    await commit(repo, { "task.md": "# goal\n" }, "init");
    await writeStateFile(trajectoryPath(repo), '{"tool":"Read","args":{"path":"kept.ts"}}\n');
    await writeStateFile(baselinePath(repo), "cafebabe");

    await runSessionStart({ source: "resume", cwd: repo }, repo);

    expect(await readFile(trajectoryPath(repo), "utf8")).toContain("kept.ts");
    expect(await readFile(baselinePath(repo), "utf8")).toBe("cafebabe");
  });

  it("does not throw and writes no start_head when there is no git repo", async () => {
    repo = await makeNonRepoDir();
    await expect(runSessionStart({ source: "startup", cwd: repo }, repo)).resolves.toBeUndefined();
    await expect(readFile(startHeadPath(repo), "utf8")).rejects.toThrow();
  });
});
