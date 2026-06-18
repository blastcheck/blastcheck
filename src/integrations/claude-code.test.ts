import { describe, expect, it, vi } from "vitest";

const { runInitMock } = vi.hoisted(() => ({
  runInitMock: vi.fn(),
}));

vi.mock("../hooks/init.js", () => ({ runInit: runInitMock }));

import { claudeCodeIntegration } from "./claude-code.js";

describe("claude-code integration", () => {
  it("delegates installation to the existing Claude Code hook installer", async () => {
    runInitMock.mockResolvedValue({ added: 3, settingsPath: ".claude/settings.json" });

    await expect(claudeCodeIntegration.install({ cwd: "/repo" })).resolves.toEqual({
      agent: "claude-code",
    });

    expect(runInitMock).toHaveBeenCalledWith({ cwd: "/repo" });
  });
});
