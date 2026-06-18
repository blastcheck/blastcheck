export type AgentId = "claude-code" | "codex" | "opencode" | "github";

export interface InstallOptions {
  cwd: string;
}

export interface InstallResult {
  agent: AgentId;
}

export interface AgentIntegration {
  id: AgentId;
  displayName: string;
  install(options: InstallOptions): Promise<InstallResult>;
}
