import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isExecutableOnPath } from "./runtime.js";

const isWindows = process.platform === "win32";

describe("isExecutableOnPath", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "blastcheck-runtime-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Write a file named `opencode` in a fresh PATH dir and chmod it. */
  async function writeBin(name: string, mode: number): Promise<string> {
    const binDir = join(dir, "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, name), "#!/bin/sh\necho ok\n", "utf8");
    await chmod(join(binDir, name), mode);
    return binDir;
  }

  it("finds an executable named `opencode` on the injected PATH", async () => {
    const binDir = await writeBin("opencode", 0o755);
    expect(await isExecutableOnPath("opencode", { PATH: binDir })).toBe(true);
  });

  it("returns false when PATH is empty or unset", async () => {
    expect(await isExecutableOnPath("opencode", { PATH: "" })).toBe(false);
    expect(await isExecutableOnPath("opencode", {})).toBe(false);
  });

  it("returns false when a PATH dir exists but has no matching binary", async () => {
    const binDir = join(dir, "empty");
    await mkdir(binDir, { recursive: true });
    expect(await isExecutableOnPath("opencode", { PATH: binDir })).toBe(false);
  });

  it("returns false for a non-existent PATH dir (never throws)", async () => {
    expect(await isExecutableOnPath("opencode", { PATH: join(dir, "does-not-exist") })).toBe(false);
  });

  // The executable-bit check is POSIX-only; on Windows access() ignores X_OK so
  // a present-but-non-exec file would resolve true. Guard the assertion.
  it.skipIf(isWindows)("returns false for a present but non-executable `opencode`", async () => {
    const binDir = await writeBin("opencode", 0o644);
    expect(await isExecutableOnPath("opencode", { PATH: binDir })).toBe(false);
  });

  it("scans every entry of a multi-dir PATH", async () => {
    const binDir = await writeBin("opencode", 0o755);
    const path = ["/nonexistent/a", "/nonexistent/b", binDir].join(delimiter);
    expect(await isExecutableOnPath("opencode", { PATH: path })).toBe(true);
  });
});
