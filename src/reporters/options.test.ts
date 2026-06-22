import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSurfacingOptions } from "./options.js";

describe("resolveSurfacingOptions", () => {
  let dir: string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "blastcheck-surfacing-"));
  });
  afterEach(async () => {
    process.env = { ...savedEnv };
    await rm(dir, { recursive: true, force: true });
  });

  it("defaults to passive (both off) when nothing is configured", async () => {
    expect(await resolveSurfacingOptions(dir)).toEqual({ feedback: false, block: false });
  });

  it("reads the .blastcheck.yml surfacing block", async () => {
    await writeFile(join(dir, ".blastcheck.yml"), "surfacing:\n  feedback: true\n  block: true\n");
    expect(await resolveSurfacingOptions(dir)).toEqual({ feedback: true, block: true });
  });

  it("ignores an absent surfacing block but keeps the rest of the file valid", async () => {
    await writeFile(join(dir, ".blastcheck.yml"), "deny:\n  - secrets/**\n");
    expect(await resolveSurfacingOptions(dir)).toEqual({ feedback: false, block: false });
  });

  it("env vars override the file (per-invocation)", async () => {
    await writeFile(join(dir, ".blastcheck.yml"), "surfacing:\n  feedback: true\n");
    process.env.BLASTCHECK_FEEDBACK = "0";
    process.env.BLASTCHECK_BLOCK = "yes";
    expect(await resolveSurfacingOptions(dir)).toEqual({ feedback: false, block: true });
  });

  it("does not throw on malformed YAML — degrades to defaults", async () => {
    await writeFile(join(dir, ".blastcheck.yml"), "surfacing: : : not yaml\n");
    expect(await resolveSurfacingOptions(dir)).toEqual({ feedback: false, block: false });
  });
});
