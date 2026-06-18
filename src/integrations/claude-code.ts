import { runInit } from "../hooks/init.js";
import type { AgentIntegration } from "./types.js";

export const claudeCodeIntegration: AgentIntegration = {
  id: "claude-code",
  displayName: "Claude Code",
  async install(options) {
    await runInit({ cwd: options.cwd });
    return { agent: "claude-code" };
  },
};
