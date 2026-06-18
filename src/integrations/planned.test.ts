import { describe, expect, it } from "vitest";
import { codexIntegration } from "./codex.js";
import { githubIntegration } from "./github.js";
import { opencodeIntegration } from "./opencode.js";

describe("planned integrations", () => {
  it("fails codex installs explicitly until implemented", async () => {
    await expect(codexIntegration.install({ cwd: "/repo" })).rejects.toThrow(
      "codex installer is not implemented yet; planned in Story 2.1",
    );
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
});
