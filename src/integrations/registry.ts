import { claudeCodeIntegration } from "./claude-code.js";
import { codexIntegration } from "./codex.js";
import { githubIntegration } from "./github.js";
import { opencodeIntegration } from "./opencode.js";
import type { AgentId, AgentIntegration } from "./types.js";

export const SUPPORTED_AGENT_IDS = ["claude-code", "codex", "opencode", "github"] as const;

const integrations: Record<AgentId, AgentIntegration> = {
  "claude-code": claudeCodeIntegration,
  codex: codexIntegration,
  opencode: opencodeIntegration,
  github: githubIntegration,
};

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && SUPPORTED_AGENT_IDS.includes(value as AgentId);
}

export function getIntegration(id: AgentId): AgentIntegration {
  return integrations[id];
}

export function supportedAgentsForMessage(): string {
  return SUPPORTED_AGENT_IDS.join(", ");
}

export type { AgentId, AgentIntegration, InstallOptions, InstallResult } from "./types.js";
