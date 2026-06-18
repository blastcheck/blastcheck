import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adaptCursorStream } from "./cursor.js";

const FIXTURES = join(process.cwd(), "tests/fixtures/trajectories");

describe("cursor stream-json adapter", () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes a stream: shell→cmd, write→path, joins completed by id", async () => {
    const raw = await readFile(join(FIXTURES, "cursor-stream.sample.jsonl"), "utf8");
    const events = adaptCursorStream(raw);

    expect(events).toEqual([
      {
        tool: "shell",
        args: { cmd: "git diff --stat" },
        step: 1,
        exit_code: 0,
        stdout_tail: "1 file changed",
      },
      // Write has no completed record → no result fields (honest degradation).
      { tool: "write", args: { path: "src/new.ts" }, step: 2 },
      // Destructive shell with no completed → partial, but still classified as shell.
      { tool: "shell", args: { cmd: "rm .env" }, step: 3 },
    ]);
  });

  it("ignores non-tool_call events (user/assistant/result)", () => {
    const events = adaptCursorStream(
      [
        '{"type":"user","message":"hi"}',
        '{"type":"assistant","message":"ok"}',
        '{"type":"result","subtype":"success"}',
      ].join("\n"),
    );
    expect(events).toEqual([]);
  });

  it("maps read/edit tool calls to args.path", () => {
    const events = adaptCursorStream(
      [
        '{"type":"tool_call","subtype":"started","tool_call":{"readToolCall":{"args":{"path":"a.ts"}}}}',
        '{"type":"tool_call","subtype":"started","tool_call":{"editToolCall":{"args":{"path":"b.ts"}}}}',
      ].join("\n"),
    );
    expect(events).toEqual([
      { tool: "read", args: { path: "a.ts" }, step: 1 },
      { tool: "edit", args: { path: "b.ts" }, step: 2 },
    ]);
  });

  it("skips a broken NDJSON line without throwing (AC3)", () => {
    const events = adaptCursorStream(
      [
        "{ broken",
        '{"type":"tool_call","subtype":"started","tool_call":{"shellToolCall":{"args":{"command":"ls"}}}}',
      ].join("\n"),
    );
    expect(events).toEqual([{ tool: "shell", args: { cmd: "ls" }, step: 1 }]);
  });
});
