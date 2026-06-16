import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupRepo, commit, makeTempRepo } from "../../tests/fixtures/repos/make-repo.js";
import { DEFAULT_BUDGET, DEFAULT_DENY, DEFAULT_THRESHOLDS } from "./defaults.js";
import { resolveContract } from "./resolve.js";

const taskMd = (goal: string, allow: string[]) =>
  `---\ngoal: ${JSON.stringify(goal)}\nallow:\n${allow.map((a) => `  - ${JSON.stringify(a)}`).join("\n")}\n---\n# Task\n`;

describe("resolveContract", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeTempRepo();
  });

  afterEach(async () => {
    await cleanupRepo(repo);
  });

  it("reads allow/goal from the baseline task.md and defaults the rest", async () => {
    const baseline = await commit(
      repo,
      { "task.md": taskMd("Add rate limiting", ["src/auth/**", "tests/auth/**"]) },
      "baseline",
    );

    const contract = await resolveContract({ baselineSha: baseline, cwd: repo });

    expect(contract.goal).toBe("Add rate limiting");
    expect(contract.allow).toEqual(["src/auth/**", "tests/auth/**"]);
    expect(contract.deny).toEqual([...DEFAULT_DENY]);
    expect(contract.budget).toEqual(DEFAULT_BUDGET);
    expect(contract.thresholds).toEqual(DEFAULT_THRESHOLDS);
    expect(contract.requiredChecks).toEqual([]);
  });

  it("pins allow/goal to the baseline version — HEAD tampering is ignored (FR3)", async () => {
    const baseline = await commit(
      repo,
      { "task.md": taskMd("Honest goal", ["src/auth/**"]) },
      "baseline",
    );
    // The agent rewrites its own promise after the fact.
    await commit(repo, { "task.md": taskMd("Rewritten goal", ["**"]) }, "tampered");

    const contract = await resolveContract({ baselineSha: baseline, cwd: repo });

    expect(contract.goal).toBe("Honest goal");
    expect(contract.allow).toEqual(["src/auth/**"]);
  });

  it("degrades to empty allow / null goal when task.md is absent (AR4)", async () => {
    const baseline = await commit(repo, { "README.md": "# repo\n" }, "baseline");

    const contract = await resolveContract({ baselineSha: baseline, cwd: repo });

    expect(contract.allow).toEqual([]);
    expect(contract.goal).toBeNull();
  });

  it("autodetects required_checks from package.json on disk (source: auto)", async () => {
    const baseline = await commit(
      repo,
      {
        "task.md": taskMd("g", ["src/**"]),
        "package.json": JSON.stringify({ scripts: { test: "vitest", lint: "biome check" } }),
      },
      "baseline",
    );

    const contract = await resolveContract({ baselineSha: baseline, cwd: repo });

    expect(contract.requiredChecks).toEqual([
      { cmd: "npm test", source: "auto" },
      { cmd: "npm run lint", source: "auto" },
    ]);
  });

  it("layers .blastcheck.yml over defaults and autodetect", async () => {
    const baseline = await commit(
      repo,
      {
        "task.md": taskMd("g", ["src/**"]),
        "package.json": JSON.stringify({ scripts: { test: "vitest" } }),
        ".blastcheck.yml": [
          "deny:",
          '  - "infra/**"',
          "budget:",
          "  max_tool_calls: 20",
          "thresholds:",
          "  scope_adherence: 0.7",
          "required_checks:",
          '  - "npm test"',
          '  - "npm run e2e"',
        ].join("\n"),
      },
      "baseline",
    );

    const contract = await resolveContract({ baselineSha: baseline, cwd: repo });

    expect(contract.deny).toEqual(["infra/**"]);
    // Partial budget override merges over defaults.
    expect(contract.budget).toEqual({ ...DEFAULT_BUDGET, maxToolCalls: 20 });
    expect(contract.thresholds).toEqual({ ...DEFAULT_THRESHOLDS, scopeAdherence: 0.7 });
    // `npm test` collides → upgraded to explicit (hard gate); `npm run e2e` added.
    expect(contract.requiredChecks).toEqual([
      { cmd: "npm test", source: "explicit" },
      { cmd: "npm run e2e", source: "explicit" },
    ]);
  });

  it("drops unknown threshold keys instead of merging them into the contract", async () => {
    const baseline = await commit(
      repo,
      {
        "task.md": taskMd("g", ["src/**"]),
        ".blastcheck.yml": "thresholds:\n  scope_adherence: 0.7\n  bogus_score: 0.1\n",
      },
      "baseline",
    );

    const contract = await resolveContract({ baselineSha: baseline, cwd: repo });

    expect(contract.thresholds).toEqual({ ...DEFAULT_THRESHOLDS, scopeAdherence: 0.7 });
    expect(contract.thresholds.bogusScore).toBeUndefined();
  });

  it("degrades to defaults when .blastcheck.yml is invalid YAML (no throw)", async () => {
    const baseline = await commit(
      repo,
      { "task.md": taskMd("g", ["src/**"]), ".blastcheck.yml": "deny: [unterminated\n" },
      "baseline",
    );

    const contract = await resolveContract({ baselineSha: baseline, cwd: repo });

    expect(contract.deny).toEqual([...DEFAULT_DENY]);
  });
});
