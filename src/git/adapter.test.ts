import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupRepo,
  commit,
  gitExec,
  makeNonRepoDir,
  makeTempRepo,
} from "../../tests/fixtures/repos/make-repo.js";
import { diffNumstat, diffPatch, GitError, headSha, lsFiles, showTaskMd } from "./adapter.js";

describe("git adapter", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeTempRepo();
  });

  afterEach(async () => {
    await cleanupRepo(repo);
  });

  describe("diffNumstat", () => {
    it("returns added/removed counts and normalized paths for a valid sha", async () => {
      const baseline = await commit(
        repo,
        { "a.txt": "one\ntwo\n", "task.md": "# task\n" },
        "baseline",
      );
      await commit(
        repo,
        { "a.txt": "one\ntwo\nthree\nfour\n", "src/b.txt": "new\n" },
        "agent changes",
      );

      const entries = await diffNumstat(baseline, { cwd: repo });
      const byPath = new Map(entries.map((e) => [e.path, e]));

      expect(byPath.has("a.txt")).toBe(true);
      expect(byPath.has("src/b.txt")).toBe(true);
      expect(byPath.get("a.txt")?.added).toBe(2);
      expect(byPath.get("a.txt")?.removed).toBe(0);
      expect(byPath.get("src/b.txt")?.added).toBe(1);
    });

    it("reports null added/removed for binary files", async () => {
      const baseline = await commit(repo, { "keep.txt": "x\n" }, "baseline");
      await commit(repo, { "blob.bin": new Uint8Array([0, 1, 2, 0, 255, 7]) }, "add binary");

      const entries = await diffNumstat(baseline, { cwd: repo });
      const binary = entries.find((e) => e.path === "blob.bin");

      expect(binary).toBeDefined();
      expect(binary?.added).toBeNull();
      expect(binary?.removed).toBeNull();
    });

    it("reports the new path for a renamed file (not a garbage `old => new`)", async () => {
      const baseline = await commit(repo, { "sub/old.txt": "stable content\n" }, "baseline");
      await gitExec(repo, ["mv", "sub/old.txt", "sub/new.txt"]);
      await gitExec(repo, ["commit", "-q", "-m", "rename"]);

      const entries = await diffNumstat(baseline, { cwd: repo });
      const paths = entries.map((e) => e.path);

      expect(paths).toContain("sub/new.txt");
      expect(paths.some((p) => p.includes("=>"))).toBe(false);
    });

    it("keeps non-ASCII paths verbatim (no octal-escaped quoting)", async () => {
      const baseline = await commit(repo, { "keep.txt": "x\n" }, "baseline");
      await commit(repo, { "café.txt": "résumé\n" }, "add unicode file");

      const entries = await diffNumstat(baseline, { cwd: repo });
      expect(entries.map((e) => e.path)).toContain("café.txt");
    });

    it("throws GitError on an unreadable sha", async () => {
      await commit(repo, { "a.txt": "x\n" }, "baseline");
      await expect(diffNumstat("deadbeefdeadbeef", { cwd: repo })).rejects.toBeInstanceOf(GitError);
    });

    it("throws GitError when there is no git repo", async () => {
      const nonRepo = await makeNonRepoDir();
      try {
        await expect(diffNumstat("HEAD", { cwd: nonRepo })).rejects.toBeInstanceOf(GitError);
      } finally {
        await cleanupRepo(nonRepo);
      }
    });
  });

  describe("showTaskMd", () => {
    it("returns task.md content when present at the sha", async () => {
      const sha = await commit(repo, { "task.md": "# the task\nbody\n" }, "with task");
      const content = await showTaskMd(sha, { cwd: repo });
      expect(content).toBe("# the task\nbody\n");
    });

    it("returns null (signal) when task.md is absent at the sha — does not throw", async () => {
      const sha = await commit(repo, { "a.txt": "x\n" }, "no task.md");
      const content = await showTaskMd(sha, { cwd: repo });
      expect(content).toBeNull();
    });

    it("throws GitError on an unreadable sha", async () => {
      await commit(repo, { "a.txt": "x\n" }, "baseline");
      await expect(showTaskMd("deadbeefdeadbeef", { cwd: repo })).rejects.toBeInstanceOf(GitError);
    });
  });

  describe("lsFiles", () => {
    it("counts tracked files at baseline", async () => {
      await commit(repo, { "a.txt": "x\n", "src/b.ts": "y\n", "task.md": "z\n" }, "baseline");
      const count = await lsFiles({ cwd: repo });
      expect(count).toBe(3);
    });
  });

  describe("headSha", () => {
    it("returns the current HEAD commit sha", async () => {
      const sha = await commit(repo, { "a.txt": "x\n" }, "baseline");
      const head = await headSha({ cwd: repo });
      expect(head).toBe(sha);
      // A sha, not a ref name, and with no trailing whitespace.
      expect(head).toMatch(/^[0-9a-f]{40}$/);
    });

    it("throws GitError when there is no git repo", async () => {
      const nonRepo = await makeNonRepoDir();
      try {
        await expect(headSha({ cwd: nonRepo })).rejects.toBeInstanceOf(GitError);
      } finally {
        await cleanupRepo(nonRepo);
      }
    });
  });

  describe("diffPatch", () => {
    it("returns the unified patch text for a valid sha", async () => {
      const baseline = await commit(repo, { "a.txt": "one\n", "task.md": "# task\n" }, "baseline");
      await commit(repo, { "a.txt": "one\ntwo\n" }, "agent changes");

      const patch = await diffPatch(baseline, { cwd: repo });
      expect(patch).toContain("a.txt");
      expect(patch).toContain("+two");
    });

    it("returns an empty string when nothing changed", async () => {
      const baseline = await commit(repo, { "a.txt": "one\n" }, "baseline");
      expect(await diffPatch(baseline, { cwd: repo })).toBe("");
    });

    it("throws GitError when there is no git repo", async () => {
      const nonRepo = await makeNonRepoDir();
      try {
        await expect(diffPatch("HEAD", { cwd: nonRepo })).rejects.toBeInstanceOf(GitError);
      } finally {
        await cleanupRepo(nonRepo);
      }
    });

    it("throws GitError for a bad sha in a real repo", async () => {
      await commit(repo, { "a.txt": "one\n" }, "baseline");
      // The dedup chain relies on this throwing (→ worktreeSignature returns
      // undefined → surface) rather than silently returning "" and false-silencing.
      await expect(diffPatch("deadbeef", { cwd: repo })).rejects.toBeInstanceOf(GitError);
    });
  });
});
