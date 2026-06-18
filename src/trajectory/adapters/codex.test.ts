import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adaptCodexRollout } from "./codex.js";

const FIXTURES = join(process.cwd(), "tests/fixtures/trajectories");

describe("codex rollout adapter", () => {
  beforeEach(() => {
    // Diagnostics for skipped/broken records go to stderr — silence them here.
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes a rollout: shell→cmd, apply_patch→path, joins results by call_id", async () => {
    const raw = await readFile(join(FIXTURES, "codex-rollout.sample.jsonl"), "utf8");
    const events = adaptCodexRollout(raw);

    expect(events).toEqual([
      {
        tool: "shell",
        args: { cmd: "git status" },
        step: 1,
        ts: "2026-06-18T10:00:01Z",
        exit_code: 0,
        stdout_tail: "On branch main",
      },
      // Partial: the destructive command has no result record → no exit_code/tails.
      {
        tool: "shell",
        args: { cmd: "rm .env" },
        step: 2,
        ts: "2026-06-18T10:00:03Z",
      },
      {
        tool: "apply_patch",
        args: { path: "src/app.ts" },
        step: 3,
        ts: "2026-06-18T10:00:04Z",
        stdout_tail: "Success. Updated src/app.ts",
      },
    ]);
  });

  it("maps every exec-tool alias to the shell tool with args.cmd (AC2)", () => {
    for (const name of ["shell", "exec_command", "local_shell"]) {
      const line = JSON.stringify({
        timestamp: "2026-06-18T10:00:00Z",
        type: "response_item",
        payload: { type: "function_call", name, arguments: '{"command":"echo hi"}', call_id: "c" },
      });
      const [event] = adaptCodexRollout(line);
      expect(event).toMatchObject({ tool: "shell", args: { cmd: "echo hi" } });
    }
  });

  it("skips a record with unparseable arguments without throwing (AC3)", () => {
    const line = JSON.stringify({
      type: "response_item",
      payload: { type: "function_call", name: "shell", arguments: "{not json", call_id: "x" },
    });
    expect(() => adaptCodexRollout(line)).not.toThrow();
    expect(adaptCodexRollout(line)).toEqual([]);
  });

  it("degrades honestly when the result carries no exit_code", () => {
    const lines = [
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell",
          arguments: '{"command":"npm test"}',
          call_id: "c1",
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "function_call_output", call_id: "c1", output: "tests ran" },
      }),
    ].join("\n");
    const [event] = adaptCodexRollout(lines);
    expect(event).toEqual({
      tool: "shell",
      args: { cmd: "npm test" },
      step: 1,
      stdout_tail: "tests ran",
    });
    expect(event).not.toHaveProperty("exit_code");
  });
});
