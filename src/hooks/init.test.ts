import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInit } from "./init.js";

interface HookHandler {
  type?: string;
  command?: string;
}
interface MatcherGroup {
  matcher?: string;
  hooks?: HookHandler[];
}
interface Settings {
  hooks?: Record<string, MatcherGroup[]>;
  permissions?: { allow?: string[] };
}

const settingsFile = (dir: string) => join(dir, ".claude", "settings.json");
const readSettings = async (dir: string): Promise<Settings> =>
  JSON.parse(await readFile(settingsFile(dir), "utf8")) as Settings;

/** Collect every installed hook command across all events. */
function allCommands(settings: Settings): string[] {
  const cmds: string[] = [];
  for (const groups of Object.values(settings.hooks ?? {})) {
    for (const group of groups) {
      for (const handler of group.hooks ?? []) {
        if (handler.command !== undefined) cmds.push(handler.command);
      }
    }
  }
  return cmds;
}

describe("init installer", () => {
  let dir: string;

  beforeEach(async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    dir = await mkdtemp(join(tmpdir(), "blastcheck-init-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("creates settings.json with all three hooks and gitignores .blastcheck/", async () => {
    const result = await runInit({ cwd: dir });

    expect(result.added).toBe(3);
    const settings = await readSettings(dir);
    expect(settings.hooks?.SessionStart?.[0]?.matcher).toBe("startup|resume|clear");
    expect(settings.hooks?.PostToolUse?.[0]?.matcher).toBe("*");
    // Stop has no matcher.
    expect(settings.hooks?.Stop?.[0]).not.toHaveProperty("matcher");
    expect(allCommands(settings).sort()).toEqual([
      "blastcheck hook post-tool-use",
      "blastcheck hook session-start",
      "blastcheck hook stop",
    ]);

    const gitignore = await readFile(join(dir, ".gitignore"), "utf8");
    expect(gitignore).toContain(".blastcheck/");
  });

  it("is idempotent — re-running adds nothing and does not duplicate", async () => {
    await runInit({ cwd: dir });
    const second = await runInit({ cwd: dir });

    expect(second.added).toBe(0);
    const settings = await readSettings(dir);
    expect(allCommands(settings)).toHaveLength(3);
    // .gitignore not duplicated either.
    const gitignore = await readFile(join(dir, ".gitignore"), "utf8");
    expect(gitignore.match(/\.blastcheck\//g)).toHaveLength(1);
  });

  it("merges into existing settings, preserving unrelated hooks and keys", async () => {
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(
      settingsFile(dir),
      JSON.stringify({
        permissions: { allow: ["Bash(ls)"] },
        hooks: {
          PostToolUse: [
            { matcher: "Write", hooks: [{ type: "command", command: "my-formatter" }] },
          ],
        },
      }),
    );

    await runInit({ cwd: dir });
    const settings = await readSettings(dir);

    // Unrelated key preserved.
    expect(settings.permissions?.allow).toEqual(["Bash(ls)"]);
    // Pre-existing user hook preserved.
    expect(allCommands(settings)).toContain("my-formatter");
    // Our PostToolUse hook added in a NEW `*` group (the `Write` group is untouched).
    const starGroup = settings.hooks?.PostToolUse?.find((g) => g.matcher === "*");
    expect(starGroup?.hooks?.[0]?.command).toBe("blastcheck hook post-tool-use");
    expect(allCommands(settings)).toContain("blastcheck hook stop");
  });

  it("appends to an existing .gitignore without a trailing newline", async () => {
    await writeFile(join(dir, ".gitignore"), "node_modules");

    await runInit({ cwd: dir });
    const gitignore = await readFile(join(dir, ".gitignore"), "utf8");

    expect(gitignore).toBe("node_modules\n.blastcheck/\n");
  });

  it("recovers from a corrupt settings.json by starting fresh", async () => {
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(settingsFile(dir), "{ not json");

    const result = await runInit({ cwd: dir });
    expect(result.added).toBe(3);
    expect(allCommands(await readSettings(dir))).toHaveLength(3);
  });
});
