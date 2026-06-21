import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { githubIntegration } from "./github.js";
import { manifestPath } from "./manifest.js";

// NOTE: codex (Story 2.1, see codex.test.ts) and opencode (Story 3.1, see
// opencode.test.ts) now ship real installers. Only github remains a throwing
// stub here.

describe("planned integrations", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "blastcheck-planned-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("fails github installs explicitly until implemented", async () => {
    await expect(githubIntegration.install({ cwd: "/repo" })).rejects.toThrow(
      "github installer is not implemented yet; planned after this milestone",
    );
  });

  it("does not create an install manifest for planned integrations", async () => {
    await expect(githubIntegration.install({ cwd: dir })).rejects.toThrow();

    await expect(readFile(manifestPath(dir), "utf8")).rejects.toThrow();
  });
});
