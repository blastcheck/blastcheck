/**
 * End-to-end audit on a programmatically built git repo (AR10).
 *
 * Drives the real `runAudit` (and the CLI `main`) against a throwaway repo from
 * `make-repo.ts` — no mocks, no committed `.git` snapshots. Two scenarios:
 *  (a) a clean changeset within `allow` → `pass` / exit 0;
 *  (b) a file under `deny` → the `denied-files` gate fails → `fail` / exit 1.
 *
 * `run_id` is a timestamp and is never pinned.
 */

import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupRepo,
  commit,
  type FileSpec,
  makeTempRepo,
} from "../tests/fixtures/repos/make-repo.js";
import { main } from "./cli.js";
import { GitError } from "./git/adapter.js";
import { runAudit } from "./index.js";
import { scorecardSchema } from "./scorecard/schema.js";
import { EXIT } from "./types.js";

/** Baseline `task.md` declaring `src/**` in scope. */
const TASK_MD = '---\ngoal: implement the feature\nallow:\n  - "src/**"\n---\n# task\nbody\n';
const TRAJECTORY_FIXTURES = `${process.cwd()}/tests/fixtures/trajectories`;

/**
 * A baseline with enough tracked files that a small edit stays under the churn
 * budget — `churn_pct` uses a files-proxy denominator (Story 1.3 debt #3), so a
 * tiny repo would trip the churn gate on any change.
 */
function baselineFiles(): FileSpec {
  const files: FileSpec = { "task.md": TASK_MD };
  for (let i = 0; i < 60; i++) files[`src/f${i}.ts`] = `export const f${i} = ${i};\n`;
  return files;
}

describe("runAudit (git-only E2E)", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeTempRepo();
  });

  afterEach(async () => {
    await cleanupRepo(repo);
  });

  it("(a) a clean in-scope changeset → pass, valid scorecard, trajectory absent", async () => {
    const baseline = await commit(repo, baselineFiles(), "baseline");
    await commit(repo, { "src/f0.ts": "export const f0 = 999;\n" }, "in-scope edit");

    const sc = await runAudit({ cwd: repo, baselineSha: baseline });

    // Output is a valid scorecard (passes its own schema).
    expect(scorecardSchema.safeParse(sc).success).toBe(true);
    expect(sc.verdict).toBe("pass");

    // git-only: no trajectory, agent unknown, head/baseline recorded.
    expect(sc.evidence_level.trajectory).toBe("absent");
    expect(sc.agent).toBeNull();
    expect(sc.baseline_sha).toBe(baseline);
    expect(sc.head_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(sc.task_goal).toBe("implement the feature");

    // The three git-only checks ran (`full`). The trajectory checks are now
    // registered (Story 2.2), so in a git-only run the runner's requires-gating
    // marks them `skipped` — the honest "registered but no trajectory to analyse"
    // signal, alongside the `trajectory: 'absent'` flag above.
    expect(sc.evidence_level.checks["denied-files"]).toBe("full");
    expect(sc.evidence_level.checks["scope-adhesion"]).toBe("full");
    expect(sc.evidence_level.checks.churn).toBe("full");
    expect(sc.evidence_level.checks["extraneous-tool-calls"]).toBe("skipped");
    expect(sc.evidence_level.checks["required-checks"]).toBe("skipped");
    expect(sc.evidence_level.checks["loop-detection"]).toBe("skipped");

    expect(sc.gates).toEqual({ "denied-files": "pass" });
  });

  it("(b) a file under deny → denied-files gate fail → verdict fail", async () => {
    const baseline = await commit(repo, baselineFiles(), "baseline");
    // `.env` matches the default deny glob `**/.env*`.
    await commit(repo, { ".env": "SECRET=leaked\n" }, "leak a secret");

    const sc = await runAudit({ cwd: repo, baselineSha: baseline });

    expect(scorecardSchema.safeParse(sc).success).toBe(true);
    expect(sc.verdict).toBe("fail");
    expect(sc.gates["denied-files"]).toBe("fail");
    expect(sc.findings.some((f) => f.check === "denied-files" && f.severity === "high")).toBe(true);
    expect(sc.evidence_level.trajectory).toBe("absent");
  });

  it("marks trajectory evidence present only when the loaded file has usable events", async () => {
    const baseline = await commit(repo, baselineFiles(), "baseline");
    await commit(repo, { "src/f0.ts": "export const f0 = 999;\n" }, "in-scope edit");

    const sc = await runAudit({
      cwd: repo,
      baselineSha: baseline,
      trajectoryPath: `${TRAJECTORY_FIXTURES}/partial-fields.trajectory.jsonl`,
    });

    expect(scorecardSchema.safeParse(sc).success).toBe(true);
    expect(sc.evidence_level.trajectory).toBe("present");
    // With a usable trajectory the trajectory checks actually run (`full`).
    expect(sc.evidence_level.checks["extraneous-tool-calls"]).toBe("full");
    expect(sc.evidence_level.checks["required-checks"]).toBe("full");
    expect(sc.evidence_level.checks["loop-detection"]).toBe("full");
  });

  it("keeps trajectory evidence absent when the file has no usable events", async () => {
    const baseline = await commit(repo, baselineFiles(), "baseline");
    await commit(repo, { "src/f0.ts": "export const f0 = 999;\n" }, "in-scope edit");

    const sc = await runAudit({
      cwd: repo,
      baselineSha: baseline,
      trajectoryPath: `${TRAJECTORY_FIXTURES}/no-usable.trajectory.jsonl`,
    });

    expect(scorecardSchema.safeParse(sc).success).toBe(true);
    expect(sc.evidence_level.trajectory).toBe("absent");
  });

  it("resolves a relative trajectory path against the audited cwd", async () => {
    const baseline = await commit(repo, baselineFiles(), "baseline");
    await commit(repo, { "src/f0.ts": "export const f0 = 999;\n" }, "in-scope edit");
    await writeFile(
      `${repo}/trajectory.jsonl`,
      '{"tool":"Bash","args":{"cmd":"npm test"}}\n',
      "utf8",
    );

    const sc = await runAudit({
      cwd: repo,
      baselineSha: baseline,
      trajectoryPath: "trajectory.jsonl",
    });

    expect(scorecardSchema.safeParse(sc).success).toBe(true);
    expect(sc.evidence_level.trajectory).toBe("present");
  });

  it("throws a GitError on an unreadable baseline sha (→ tool error)", async () => {
    await commit(repo, baselineFiles(), "baseline");
    // Assert the concrete failure type, not merely "rejects with something":
    // the tool-error→exit-2 contract hangs on this being a GitError.
    await expect(runAudit({ cwd: repo, baselineSha: "deadbeefdeadbeef" })).rejects.toBeInstanceOf(
      GitError,
    );
  });
});

describe("cli main (git-only E2E exit codes)", () => {
  let repo: string;
  let origCwd: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    repo = await makeTempRepo();
    origCwd = process.cwd();
    // CLI has no --cwd flag; runAudit uses process.cwd(). chdir into the fixture.
    process.chdir(repo);
    // Keep test output clean — the run prints scorecard.json + a stderr summary.
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(async () => {
    process.chdir(origCwd);
    vi.restoreAllMocks();
    await cleanupRepo(repo);
  });

  it("exits 0 on a passing audit", async () => {
    const baseline = await commit(repo, baselineFiles(), "baseline");
    await commit(repo, { "src/f0.ts": "export const f0 = 999;\n" }, "in-scope edit");
    await expect(main(["node", "blastcheck", "run", "--baseline", baseline])).resolves.toBe(
      EXIT.OK,
    );
  });

  it("writes ONLY scorecard.json to stdout; the human summary goes to stderr", async () => {
    const baseline = await commit(repo, baselineFiles(), "baseline");
    await commit(repo, { "src/f0.ts": "export const f0 = 999;\n" }, "in-scope edit");
    await main(["node", "blastcheck", "run", "--baseline", baseline]);

    // stdout, concatenated, must be EXACTLY one valid scorecard and nothing else.
    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    const parsed = scorecardSchema.safeParse(JSON.parse(out));
    expect(parsed.success).toBe(true);

    // The human-readable summary must have gone to stderr, never stdout.
    const err = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(err).toContain("blastcheck:");
    expect(out).not.toContain("blastcheck:");
  });

  it("keeps stdout as the single scorecard JSON when --trajectory is provided", async () => {
    const baseline = await commit(repo, baselineFiles(), "baseline");
    await commit(repo, { "src/f0.ts": "export const f0 = 999;\n" }, "in-scope edit");
    await main([
      "node",
      "blastcheck",
      "run",
      "--baseline",
      baseline,
      "--trajectory",
      `${TRAJECTORY_FIXTURES}/claude-code-valid.trajectory.jsonl`,
    ]);

    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    const parsed = scorecardSchema.parse(JSON.parse(out));
    expect(parsed.evidence_level.trajectory).toBe("present");
    expect(out).not.toContain("diagnostic");
  });

  it("exits 1 on a failing audit (denied file)", async () => {
    const baseline = await commit(repo, baselineFiles(), "baseline");
    await commit(repo, { ".env": "SECRET=leaked\n" }, "leak");
    await expect(main(["node", "blastcheck", "run", "--baseline", baseline])).resolves.toBe(
      EXIT.FAIL,
    );
  });
});
