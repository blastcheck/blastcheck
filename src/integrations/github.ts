import type { AgentIntegration } from "./types.js";

export const githubIntegration: AgentIntegration = {
  id: "github",
  displayName: "GitHub",
  async install() {
    throw new Error("github installer is not implemented yet; planned after this milestone");
  },
};
