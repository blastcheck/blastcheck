import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codexIntegration } from "./codex.js";
import { manifestPath, readInstallManifest, upsertInstallManifest } from "./manifest.js";

// Redirect `os.homedir()` so the installer's user-level `notify` write lands in
// a temp HOME — the real `~/.codex/config.toml` must NEVER be touched. The real
// `tmpdir` is preserved (spread from the actual module).
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

/** Path to the user-level Codex config under the (mocked) temp HOME. */
const codexConfig = (home: string) => join(home, ".codex", "config.toml");

interface HookHandler {
  type?: string;
  command?: string;
}
interface MatcherGroup {
  matcher?: string;
  hooks?: HookHandler[];
}
interface HooksConfig {
  hooks?: Record<string, MatcherGroup[]>;
  [key: string]: unknown;
}

const hooksFile = (dir: string) => join(dir, ".codex", "hooks.json");
const readHooks = async (dir: string): Promise<HooksConfig> =>
  JSON.parse(await readFile(hooksFile(dir), "utf8")) as HooksConfig;

/** Collect every installed hook command across all events. */
function allCommands(config: HooksConfig): string[] {
  const cmds: string[] = [];
  for (const groups of Object.values(config.hooks ?? {})) {
    for (const group of groups) {
      for (const handler of group.hooks ?? []) {
        if (handler.command !== undefined) cmds.push(handler.command);
      }
    }
  }
  return cmds;
}

describe("codex integration installer", () => {
  let dir: string;
  let home: string;

  beforeEach(async () => {
    // Silence the installer's stderr diagnostics during the test run.
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    dir = await mkdtemp(join(tmpdir(), "blastcheck-codex-"));
    // Redirect HOME to a temp dir so the user-level `notify` write NEVER touches
    // the real `~/.codex/config.toml` (the install now writes outside the repo).
    home = await mkdtemp(join(tmpdir(), "blastcheck-codex-home-"));
    vi.mocked(homedir).mockReturnValue(home);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it("creates .codex/hooks.json with the three lifecycle commands and a needs-review manifest", async () => {
    const result = await codexIntegration.install({ cwd: dir });

    const config = await readHooks(dir);
    expect(config.hooks?.SessionStart?.[0]?.matcher).toBe("startup|resume");
    expect(config.hooks?.SessionStart?.[0]?.hooks?.[0]).toEqual({
      type: "command",
      command: "blastcheck hook codex session-start",
    });
    // PostToolUse / Stop are match-all → no `matcher` key (avoids `"*"` regex).
    expect(config.hooks?.PostToolUse?.[0]).not.toHaveProperty("matcher");
    expect(config.hooks?.Stop?.[0]).not.toHaveProperty("matcher");
    expect(allCommands(config).sort()).toEqual([
      "blastcheck hook codex post-tool-use",
      "blastcheck hook codex session-start",
      "blastcheck hook codex stop",
    ]);

    // Install result mirrors Claude Code's shape with needs-review trust.
    expect(result).toMatchObject({
      agent: "codex",
      configFiles: [".codex/hooks.json"],
      evidencePaths: {
        trajectory: ".blastcheck/trajectory.jsonl",
        baseline: ".blastcheck/baseline",
        scorecard: ".blastcheck/scorecard.json",
      },
      trust: "needs-review",
    });
  });

  it("records a codex manifest entry with needs-review trust and canonical evidence paths", async () => {
    await codexIntegration.install({ cwd: dir });
    const manifest = await readInstallManifest(dir);

    expect(manifest.integrations.codex).toMatchObject({
      agent: "codex",
      displayName: "Codex",
      configFiles: [".codex/hooks.json"],
      evidencePaths: {
        trajectory: ".blastcheck/trajectory.jsonl",
        baseline: ".blastcheck/baseline",
        scorecard: ".blastcheck/scorecard.json",
      },
      trust: "needs-review",
    });
    expect(manifest.integrations.codex?.updatedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(Object.keys(manifest.integrations)).toContain("codex");
  });

  it("preserves existing user hooks and unrelated top-level keys (structured merge)", async () => {
    await mkdir(join(dir, ".codex"), { recursive: true });
    await writeFile(
      hooksFile(dir),
      JSON.stringify({
        // Unrelated top-level key the installer must not touch.
        notify: true,
        hooks: {
          // A user PostToolUse linter (different matcher) must survive.
          PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "my-linter" }] }],
          // An unrelated event must survive verbatim.
          PreToolUse: [{ hooks: [{ type: "command", command: "user pre-tool" }] }],
        },
      }),
    );

    await codexIntegration.install({ cwd: dir });
    const config = await readHooks(dir);

    expect(config.notify).toBe(true);
    expect(config.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command).toBe("user pre-tool");
    expect(allCommands(config)).toContain("my-linter");
    // Our PostToolUse hook is added in a NEW match-all group; the `Write` group
    // is untouched.
    const managed = config.hooks?.PostToolUse?.find(
      (g) => g.hooks?.[0]?.command === "blastcheck hook codex post-tool-use",
    );
    expect(managed?.matcher).toBeUndefined();
    expect(allCommands(config)).toContain("blastcheck hook codex stop");
  });

  it("degrades a malformed .codex/hooks.json to a fresh object without throwing", async () => {
    await mkdir(join(dir, ".codex"), { recursive: true });
    await writeFile(hooksFile(dir), "{ not json");

    await expect(codexIntegration.install({ cwd: dir })).resolves.toMatchObject({
      agent: "codex",
    });
    const config = await readHooks(dir);
    expect(allCommands(config)).toHaveLength(3);
  });

  it("is idempotent — a re-run adds nothing, does not duplicate, and does not rewrite the file", async () => {
    await codexIntegration.install({ cwd: dir });
    const before = await stat(hooksFile(dir));

    await new Promise((resolve) => setTimeout(resolve, 10));
    await codexIntegration.install({ cwd: dir });
    const after = await stat(hooksFile(dir));

    const config = await readHooks(dir);
    expect(allCommands(config)).toHaveLength(3);
    // No-op re-run must not rewrite hooks.json (no mtime churn).
    expect(after.mtimeMs).toBe(before.mtimeMs);

    // Manifest stays a single codex entry, not duplicated.
    const manifest = await readInstallManifest(dir);
    expect(Object.keys(manifest.integrations)).toEqual(["codex"]);
  });

  it("does not let callers mutate canonical manifest metadata", async () => {
    const result = await codexIntegration.install({ cwd: dir });
    result.configFiles?.push("mutated.json");
    if (result.evidencePaths !== undefined) {
      result.evidencePaths.trajectory = "mutated.jsonl";
    }

    await codexIntegration.install({ cwd: dir });

    const manifest = await readInstallManifest(dir);
    expect(manifest.integrations.codex).toMatchObject({
      configFiles: [".codex/hooks.json"],
      evidencePaths: {
        trajectory: ".blastcheck/trajectory.jsonl",
        baseline: ".blastcheck/baseline",
        scorecard: ".blastcheck/scorecard.json",
      },
    });
  });

  it("does not create or mutate the manifest when the hook write fails", async () => {
    // `.codex` exists as a FILE, so creating `.codex/hooks.json` fails — the
    // installer must throw before writing any manifest.
    await writeFile(join(dir, ".codex"), "i am a file, not a dir", "utf8");

    await expect(codexIntegration.install({ cwd: dir })).rejects.toThrow();
    await expect(readFile(manifestPath(dir), "utf8")).rejects.toThrow();
  });

  it("does not touch .gitignore (Codex config is committed project config)", async () => {
    await codexIntegration.install({ cwd: dir });
    await expect(readFile(join(dir, ".gitignore"), "utf8")).rejects.toThrow();
  });

  it("preserves an elevated trusted state across a no-op re-run", async () => {
    await codexIntegration.install({ cwd: dir });
    // Simulate the user elevating trust after reviewing the hooks in Codex `/hooks`.
    const current = (await readInstallManifest(dir)).integrations.codex;
    if (current === undefined) throw new Error("expected a codex manifest entry");
    await upsertInstallManifest(dir, { ...current, trust: "trusted" });

    // Re-run installs nothing new (hooks byte-identical) → must NOT downgrade.
    await codexIntegration.install({ cwd: dir });
    const manifest = await readInstallManifest(dir);
    expect(manifest.integrations.codex?.trust).toBe("trusted");
  });

  it("resets trust to needs-review when a re-run actually installs a managed hook", async () => {
    await codexIntegration.install({ cwd: dir });
    const current = (await readInstallManifest(dir)).integrations.codex;
    if (current === undefined) throw new Error("expected a codex manifest entry");
    await upsertInstallManifest(dir, { ...current, trust: "trusted" });
    // Drop a managed hook so the next run re-adds it → review must be re-required.
    const config = await readHooks(dir);
    if (config.hooks) delete config.hooks.Stop;
    await writeFile(hooksFile(dir), JSON.stringify(config));

    await codexIntegration.install({ cwd: dir });
    const manifest = await readInstallManifest(dir);
    expect(manifest.integrations.codex?.trust).toBe("needs-review");
    expect(allCommands(await readHooks(dir))).toContain("blastcheck hook codex stop");
  });

  it("degrades a structurally-malformed hooks tree (non-array event) without throwing", async () => {
    await mkdir(join(dir, ".codex"), { recursive: true });
    // Valid JSON object, but the event value has the wrong shape (string, not array).
    await writeFile(hooksFile(dir), JSON.stringify({ hooks: { SessionStart: "oops" } }));

    await expect(codexIntegration.install({ cwd: dir })).resolves.toMatchObject({
      agent: "codex",
    });
    expect(allCommands(await readHooks(dir))).toContain("blastcheck hook codex session-start");
  });

  // --- user-level `notify` write (AC7/AC8) — always against the temp HOME ---

  it("writes the user-level notify entry into a fresh ~/.codex/config.toml", async () => {
    await codexIntegration.install({ cwd: dir });
    const config = await readFile(codexConfig(home), "utf8");
    expect(config).toContain('notify = ["blastcheck", "notify", "codex"]');
  });

  it("inserts notify as a top-level bare key ABOVE any existing [table] (valid TOML)", async () => {
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(codexConfig(home), '[mcp_servers.foo]\ncommand = "x"\n', "utf8");

    await codexIntegration.install({ cwd: dir });
    const config = await readFile(codexConfig(home), "utf8");
    const notifyIdx = config.indexOf("notify =");
    const tableIdx = config.indexOf("[mcp_servers.foo]");
    expect(notifyIdx).toBeGreaterThanOrEqual(0);
    // The bare key must precede the first table header.
    expect(notifyIdx).toBeLessThan(tableIdx);
    // The user's table + value survive untouched.
    expect(config).toContain('command = "x"');
  });

  it("is idempotent — a re-run does not rewrite ~/.codex/config.toml (no mtime churn)", async () => {
    await codexIntegration.install({ cwd: dir });
    const before = await stat(codexConfig(home));

    await new Promise((resolve) => setTimeout(resolve, 10));
    await codexIntegration.install({ cwd: dir });
    const after = await stat(codexConfig(home));

    expect(after.mtimeMs).toBe(before.mtimeMs);
    // Exactly one notify line — not duplicated.
    const config = await readFile(codexConfig(home), "utf8");
    expect(config.match(/^\s*notify\s*=/gm)).toHaveLength(1);
  });

  it("preserves a DIFFERENT user-owned notify and does not overwrite it", async () => {
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(codexConfig(home), 'notify = ["my-own-notifier"]\n', "utf8");
    const before = await readFile(codexConfig(home), "utf8");

    await codexIntegration.install({ cwd: dir });
    const after = await readFile(codexConfig(home), "utf8");

    // Left byte-identical: the user's notify wins, blastcheck's is not injected.
    expect(after).toBe(before);
    expect(after).not.toContain("blastcheck");
  });

  it("is idempotent when our notify sits AFTER a multi-line top-level array (no duplicate key)", async () => {
    // Regression: a `[`-leading array continuation line must NOT be mistaken for
    // a `[table]` header — otherwise the top-level scan stops early, misses the
    // existing notify, and prepends a SECOND (invalid) notify on re-run.
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(
      codexConfig(home),
      'packages = [\n  ["a"],\n  ["b"],\n]\nnotify = ["blastcheck", "notify", "codex"]\n',
      "utf8",
    );
    const before = await stat(codexConfig(home));

    await new Promise((resolve) => setTimeout(resolve, 10));
    await codexIntegration.install({ cwd: dir });
    const after = await stat(codexConfig(home));

    // Detected as already-present → no rewrite, and exactly one notify line.
    expect(after.mtimeMs).toBe(before.mtimeMs);
    const config = await readFile(codexConfig(home), "utf8");
    expect(config.match(/^\s*notify\s*=/gm)).toHaveLength(1);
    expect(config).toContain('["a"]');
  });

  it("does NOT modify .codex/hooks.json definitions for the notify write (no re-trust, AC8)", async () => {
    await codexIntegration.install({ cwd: dir });
    const before = await stat(hooksFile(dir));

    await new Promise((resolve) => setTimeout(resolve, 10));
    await codexIntegration.install({ cwd: dir });
    const after = await stat(hooksFile(dir));
    // The hook command strings (trust hash) are unchanged across re-install.
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(allCommands(await readHooks(dir)).sort()).toEqual([
      "blastcheck hook codex post-tool-use",
      "blastcheck hook codex session-start",
      "blastcheck hook codex stop",
    ]);
  });
});
