import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { manifestPath, readInstallManifest } from "./manifest.js";
import { opencodeIntegration } from "./opencode.js";

const pluginFile = (dir: string) => join(dir, ".opencode", "plugins", "blastcheck.ts");
const readPlugin = (dir: string) => readFile(pluginFile(dir), "utf8");

describe("opencode integration installer", () => {
  let dir: string;

  beforeEach(async () => {
    // Silence the installer's stderr diagnostics during the test run.
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    dir = await mkdtemp(join(tmpdir(), "blastcheck-opencode-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("creates .opencode/plugins/blastcheck.ts and returns the expected InstallResult", async () => {
    const result = await opencodeIntegration.install({ cwd: dir });

    // The managed plugin file exists under cwd.
    await expect(readPlugin(dir)).resolves.toBeTypeOf("string");

    expect(result).toMatchObject({
      agent: "opencode",
      configFiles: [".opencode/plugins/blastcheck.ts"],
      evidencePaths: {
        trajectory: ".blastcheck/trajectory.jsonl",
        baseline: ".blastcheck/baseline",
        scorecard: ".blastcheck/scorecard.json",
      },
      trust: "trusted",
    });
  });

  it("generates a dependency-free, marked plugin that subscribes to lifecycle events", async () => {
    await opencodeIntegration.install({ cwd: dir });
    const content = await readPlugin(dir);

    // Ownership/idempotency marker on the first line (unchanged from 3.1).
    expect(content.startsWith("// blastcheck-managed: do not edit by hand.")).toBe(true);

    // Dependency-free (NFR15): no package import of any kind.
    expect(content).not.toContain("@opencode-ai/plugin");
    expect(content).not.toMatch(/import\s+.*\bfrom\b\s*["']/);

    // The now-real plugin (Story 3.2): exports the plugin and subscribes to the
    // session-start + tool-completed lifecycle events, forwarding each to the CLI.
    expect(content).toContain("export const BlastcheckPlugin");
    expect(content).toContain('"session.created"');
    expect(content).toContain('"tool.execute.after"');
    expect(content).toContain("blastcheck hook opencode");
    expect(content).not.toContain("return {};");

    // CAPTURE + AUDIT (Story 3.3): the session-idle end-of-turn event triggers the
    // shared audit by shelling out to `blastcheck hook opencode stop`.
    expect(content).toContain('"session.idle"');
    expect(content).toContain('forward("stop"');

    // Injection-safe + non-fatal shell-out (NFR6/NFR15): piped via a Response
    // body to stdin, swallowed via .quiet().nothrow() — never a `bash -c`.
    expect(content).toContain("new Response(json)");
    expect(content).toContain(".quiet().nothrow()");
    expect(content).not.toContain("bash -c");

    // Exactly one trailing newline.
    expect(content.endsWith("};\n")).toBe(true);
  });

  it("records an opencode manifest entry with the plugin path and canonical evidence", async () => {
    await opencodeIntegration.install({ cwd: dir });
    const manifest = await readInstallManifest(dir);

    expect(manifest.integrations.opencode).toMatchObject({
      agent: "opencode",
      displayName: "OpenCode",
      configFiles: [".opencode/plugins/blastcheck.ts"],
      evidencePaths: {
        trajectory: ".blastcheck/trajectory.jsonl",
        baseline: ".blastcheck/baseline",
        scorecard: ".blastcheck/scorecard.json",
      },
      trust: "trusted",
    });
    expect(manifest.integrations.opencode?.updatedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(Object.keys(manifest.integrations)).toContain("opencode");
  });

  it("preserves existing .opencode/plugins content (only the managed file is touched)", async () => {
    await mkdir(join(dir, ".opencode", "plugins"), { recursive: true });
    const sibling = join(dir, ".opencode", "plugins", "my-plugin.ts");
    const siblingContent = "export const Mine = async () => ({});\n";
    await writeFile(sibling, siblingContent, "utf8");

    await opencodeIntegration.install({ cwd: dir });

    // The user's plugin survives byte-for-byte; our managed file now exists.
    expect(await readFile(sibling, "utf8")).toBe(siblingContent);
    await expect(readPlugin(dir)).resolves.toContain("blastcheck-managed");
  });

  it("is idempotent — a re-run produces one file, no mtime churn, single manifest entry", async () => {
    await opencodeIntegration.install({ cwd: dir });
    const before = await stat(pluginFile(dir));

    await new Promise((resolve) => setTimeout(resolve, 10));
    await opencodeIntegration.install({ cwd: dir });
    const after = await stat(pluginFile(dir));

    // No-op re-run must not rewrite blastcheck.ts (no mtime churn).
    expect(after.mtimeMs).toBe(before.mtimeMs);

    // Manifest stays a single opencode entry, not duplicated.
    const manifest = await readInstallManifest(dir);
    expect(Object.keys(manifest.integrations)).toEqual(["opencode"]);
  });

  it("rewrites the managed file when its content has drifted from canonical", async () => {
    await mkdir(join(dir, ".opencode", "plugins"), { recursive: true });
    await writeFile(pluginFile(dir), "// stale managed content\n", "utf8");

    await opencodeIntegration.install({ cwd: dir });

    const content = await readPlugin(dir);
    expect(content.startsWith("// blastcheck-managed: do not edit by hand.")).toBe(true);
    expect(content).toContain("export const BlastcheckPlugin");
  });

  it("does not let callers mutate canonical manifest metadata", async () => {
    const result = await opencodeIntegration.install({ cwd: dir });
    result.configFiles?.push("mutated.ts");
    if (result.evidencePaths !== undefined) {
      result.evidencePaths.trajectory = "mutated.jsonl";
    }

    await opencodeIntegration.install({ cwd: dir });

    const manifest = await readInstallManifest(dir);
    expect(manifest.integrations.opencode).toMatchObject({
      configFiles: [".opencode/plugins/blastcheck.ts"],
      evidencePaths: {
        trajectory: ".blastcheck/trajectory.jsonl",
        baseline: ".blastcheck/baseline",
        scorecard: ".blastcheck/scorecard.json",
      },
    });
  });

  it("does not create the manifest when .opencode/plugins is occupied by a file", async () => {
    // `.opencode/plugins` exists as a FILE, so the very first filesystem op —
    // `readFile(.opencode/plugins/blastcheck.ts)` — throws ENOTDIR (a path
    // component is a file) and the install aborts at the read, before mkdir or
    // the manifest. The non-ENOENT read error must propagate, not be swallowed.
    await mkdir(join(dir, ".opencode"), { recursive: true });
    await writeFile(join(dir, ".opencode", "plugins"), "i am a file, not a dir", "utf8");

    await expect(opencodeIntegration.install({ cwd: dir })).rejects.toThrow();
    await expect(readFile(manifestPath(dir), "utf8")).rejects.toThrow();
  });

  it("does not create the manifest when the plugin file write itself fails", async () => {
    // Genuine post-read / post-mkdir write failure: an existing, read-only
    // managed file lets `readFile` succeed (its content differs from canonical,
    // so the else/write branch runs) and `mkdir(..., { recursive })` is a no-op,
    // but `writeFile` then rejects with EACCES. This exercises the
    // throw-before-manifest ordering on the ACTUAL write path — the occupied-
    // path test above only reaches the read. A failed write must leave no
    // manifest behind.
    await mkdir(join(dir, ".opencode", "plugins"), { recursive: true });
    await writeFile(pluginFile(dir), "// not the canonical content\n", "utf8");
    await chmod(pluginFile(dir), 0o444);

    await expect(opencodeIntegration.install({ cwd: dir })).rejects.toThrow();
    await expect(readFile(manifestPath(dir), "utf8")).rejects.toThrow();

    // Restore write permission so the afterEach cleanup can remove the file.
    await chmod(pluginFile(dir), 0o644);
  });

  it("does not touch .gitignore (the generated plugin is committed project config)", async () => {
    await opencodeIntegration.install({ cwd: dir });
    await expect(readFile(join(dir, ".gitignore"), "utf8")).rejects.toThrow();
  });
});
