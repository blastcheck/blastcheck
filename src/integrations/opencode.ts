import type { AgentIntegration } from "./types.js";

export const opencodeIntegration: AgentIntegration = {
  id: "opencode",
  displayName: "OpenCode",
  async install() {
    throw new Error("opencode installer is not implemented yet; planned in Story 3.1");
  },
};
