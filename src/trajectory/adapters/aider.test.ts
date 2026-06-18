import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adaptAiderHistory } from "./aider.js";

const FIXTURES = join(process.cwd(), "tests/fixtures/trajectories");

describe("aider chat-history adapter", () => {
  it("extracts edited paths (SEARCH blocks) and /run commands in order", async () => {
    const raw = await readFile(join(FIXTURES, "aider-history.sample.md"), "utf8");
    const events = adaptAiderHistory(raw);

    expect(events).toEqual([
      { tool: "edit", args: { path: "src/app.ts" }, step: 1 },
      { tool: "shell", args: { cmd: "npm test" }, step: 2 },
      { tool: "shell", args: { cmd: "rm .env" }, step: 3 },
    ]);
  });

  it("degrades honestly: no exit_code/ts/tails are ever fabricated (AC4)", async () => {
    const raw = await readFile(join(FIXTURES, "aider-history.sample.md"), "utf8");
    for (const event of adaptAiderHistory(raw)) {
      expect(event).not.toHaveProperty("exit_code");
      expect(event).not.toHaveProperty("ts");
      expect(event).not.toHaveProperty("stdout_tail");
      expect(event).not.toHaveProperty("stderr_tail");
    }
  });

  it("does not treat prose mentioning a path as an edit (no false signal)", () => {
    const events = adaptAiderHistory(
      "I think src/other.ts and the README.md should change, but I won't touch them.\n",
    );
    expect(events).toEqual([]);
  });

  it("maps /run to the shell tool so it reaches the Bash gate (AC2)", () => {
    const [event] = adaptAiderHistory("#### /run rm -rf build\n");
    expect(event).toEqual({ tool: "shell", args: { cmd: "rm -rf build" }, step: 1 });
  });
});
