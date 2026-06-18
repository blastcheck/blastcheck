import { describe, expect, it } from "vitest";
import {
  getIntegration,
  isAgentId,
  SUPPORTED_AGENT_IDS,
  supportedAgentsForMessage,
} from "./registry.js";

describe("integration registry", () => {
  it("exposes a deterministic supported-agent list", () => {
    expect(SUPPORTED_AGENT_IDS).toEqual(["claude-code", "codex", "opencode", "github"]);
    expect(supportedAgentsForMessage()).toBe("claude-code, codex, opencode, github");
  });

  it("narrows supported agent ids", () => {
    expect(isAgentId("claude-code")).toBe(true);
    expect(isAgentId("codex")).toBe(true);
    expect(isAgentId("opencode")).toBe(true);
    expect(isAgentId("github")).toBe(true);
    expect(isAgentId("unknown")).toBe(false);
    expect(isAgentId(undefined)).toBe(false);
  });

  it("resolves all registered integrations", () => {
    for (const id of SUPPORTED_AGENT_IDS) {
      expect(getIntegration(id)).toMatchObject({ id });
    }
  });
});
