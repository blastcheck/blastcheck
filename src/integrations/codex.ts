import type { AgentIntegration } from "./types.js";

export const codexIntegration: AgentIntegration = {
  id: "codex",
  displayName: "Codex",
  async install() {
    throw new Error("codex installer is not implemented yet; planned in Story 2.1");
  },
};
