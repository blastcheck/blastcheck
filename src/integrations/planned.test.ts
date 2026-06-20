import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { githubIntegration } from "./github.js";
import { manifestPath } from "./manifest.js";
import { opencodeIntegration } from "./opencode.js";

// NOTE: codex is no longer a "planned" stub — its installer ships in Story 2.1
// (see codex.test.ts). Only opencode/github remain throwing stubs here.

describe("planned integrations", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "blastcheck-planned-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("fails opencode installs explicitly until implemented", async () => {
    await expect(opencodeIntegration.install({ cwd: "/repo" })).rejects.toThrow(
      "opencode installer is not implemented yet; planned in Story 3.1",
    );
  });

  it("fails github installs explicitly until implemented", async () => {
    await expect(githubIntegration.install({ cwd: "/repo" })).rejects.toThrow(
      "github installer is not implemented yet; planned after this milestone",
    );
  });

  it("does not create an install manifest for planned integrations", async () => {
    await expect(opencodeIntegration.install({ cwd: dir })).rejects.toThrow();
    await expect(githubIntegration.install({ cwd: dir })).rejects.toThrow();

    await expect(readFile(manifestPath(dir), "utf8")).rejects.toThrow();
  });
});
