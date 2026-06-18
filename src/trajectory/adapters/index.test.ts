import { describe, expect, it } from "vitest";
import { getAdapter, isTrajectoryFormat, TRAJECTORY_FORMATS } from "./index.js";

describe("adapter registry", () => {
  it("lists exactly the four supported formats", () => {
    expect(TRAJECTORY_FORMATS).toEqual(["claude-code", "codex", "cursor", "aider"]);
  });

  it("isTrajectoryFormat narrows known vs unknown formats", () => {
    expect(isTrajectoryFormat("codex")).toBe(true);
    expect(isTrajectoryFormat("gpt-pilot")).toBe(false);
  });

  it("the claude-code file adapter numbers step by line order", () => {
    const raw = [
      JSON.stringify({ tool_name: "Read", tool_input: { file_path: "a.ts" } }),
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm test" } }),
    ].join("\n");

    const events = getAdapter("claude-code")(raw);
    expect(events).toEqual([
      { tool: "Read", args: { path: "a.ts" }, step: 1 },
      { tool: "Bash", args: { cmd: "npm test" }, step: 2 },
    ]);
  });

  it("the claude-code file adapter skips malformed lines without throwing", () => {
    const raw = ["{ broken", JSON.stringify({ tool: "Bash", args: { cmd: "ls" } })].join("\n");
    const events = getAdapter("claude-code")(raw);
    expect(events).toEqual([{ tool: "Bash", args: { cmd: "ls" }, step: 1 }]);
  });
});
