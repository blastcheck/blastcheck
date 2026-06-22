import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Scorecard } from "./scorecard/schema.js";

// runAudit is mocked so the CLI's arg-parsing and exit-code mapping are tested
// in isolation — the end-to-end path against a real repo is `index.test.ts`.
const { runAuditMock } = vi.hoisted(() => ({ runAuditMock: vi.fn() }));
vi.mock("./index.js", () => ({ runAudit: runAuditMock }));

// The `init` subcommand is registry-routing only at the CLI layer; integration
// behavior is covered by integration-specific tests. Here we mock the registry
// so the CLI test stays a pure arg-parsing/exit-code check.
const { getIntegrationMock, installMock } = vi.hoisted(() => ({
  getIntegrationMock: vi.fn(),
  installMock: vi.fn(),
}));
vi.mock("./integrations/registry.js", () => ({
  getIntegration: getIntegrationMock,
  isAgentId: (value: unknown) =>
    ["claude-code", "codex", "opencode", "github"].includes(String(value)),
  supportedAgentsForMessage: () => "claude-code, codex, opencode, github",
}));

// The `status` subcommand is wiring-only at the CLI layer; the readiness
// snapshot logic is covered by `status.test.ts`. Mock the module so the CLI
// test stays a pure stdout-clean / exit-code / routing check.
const { buildReadinessSnapshotMock, printReadinessMock } = vi.hoisted(() => ({
  buildReadinessSnapshotMock: vi.fn(),
  printReadinessMock: vi.fn(),
}));
vi.mock("./integrations/status.js", () => ({
  buildReadinessSnapshot: buildReadinessSnapshotMock,
  printReadiness: printReadinessMock,
}));

// The `hook` subcommands are wiring-only at the CLI layer; their
// behavior is covered by the hooks' own tests. Here we mock them so the CLI test
// stays a pure arg-parsing/exit-code check and never blocks on real stdin.
const { runStopMock, runSessionStartMock, runPostToolUseMock, readStdinMock, runCodexNotifyMock } =
  vi.hoisted(() => ({
    runStopMock: vi.fn(),
    runSessionStartMock: vi.fn(),
    runPostToolUseMock: vi.fn(),
    readStdinMock: vi.fn(),
    runCodexNotifyMock: vi.fn(),
  }));
vi.mock("./hooks/stop.js", () => ({ runStop: runStopMock }));
vi.mock("./hooks/session-start.js", () => ({ runSessionStart: runSessionStartMock }));
vi.mock("./hooks/post-tool-use.js", () => ({ runPostToolUse: runPostToolUseMock }));
vi.mock("./hooks/notify.js", () => ({ runCodexNotify: runCodexNotifyMock }));
vi.mock("./hooks/state.js", () => ({
  readStdin: readStdinMock,
  parseHookPayload: (text: string) => (text === "" ? undefined : JSON.parse(text)),
}));

import { main } from "./cli.js";
import { EXIT } from "./types.js";

/** A full, minimal scorecard with the given verdict. */
function scorecard(verdict: Scorecard["verdict"]): Scorecard {
  return {
    schema_version: "1",
    run_id: "test-run",
    agent: null,
    baseline_sha: "base",
    head_sha: "head",
    task_goal: null,
    verdict,
    evidence_level: { trajectory: "absent", checks: {} },
    gates: {},
    scores: {},
    findings: [],
    stats: { files_changed: 0, lines_added: 0, lines_removed: 0, churn_pct: 0 },
  };
}

/** node-style argv: Commander's default `from:'node'` drops the first two. */
function argv(...args: string[]): string[] {
  return ["node", "blastcheck", ...args];
}

describe("cli main", () => {
  let stdout: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    runAuditMock.mockReset();
    getIntegrationMock.mockReset();
    installMock.mockReset();
    getIntegrationMock.mockImplementation((id: string) => ({
      id,
      displayName: id,
      install: installMock,
    }));
    installMock.mockResolvedValue({ agent: "claude-code" });
    buildReadinessSnapshotMock.mockReset();
    printReadinessMock.mockReset();
    buildReadinessSnapshotMock.mockResolvedValue({
      integrations: [],
      trajectoryPresent: false,
      baselinePresent: false,
      warnings: [],
      supportedAgents: "claude-code, codex, opencode, github",
    });
    for (const m of [runStopMock, runSessionStartMock, runPostToolUseMock, runCodexNotifyMock]) {
      m.mockReset();
    }
    runCodexNotifyMock.mockResolvedValue(undefined);
    readStdinMock.mockReset();
    readStdinMock.mockResolvedValue("");
    // Suppress (and capture) CLI output so the test log stays clean.
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("--help exits 0 without running an audit", async () => {
    await expect(main(argv("--help"))).resolves.toBe(EXIT.OK);
    expect(runAuditMock).not.toHaveBeenCalled();
  });

  it("--version exits 0", async () => {
    await expect(main(argv("--version"))).resolves.toBe(EXIT.OK);
  });

  it("run without --baseline is a usage error → exit 2", async () => {
    await expect(main(argv("run"))).resolves.toBe(EXIT.TOOL_ERROR);
    expect(runAuditMock).not.toHaveBeenCalled();
  });

  it("a pass verdict → exit 0 and scorecard.json on stdout", async () => {
    runAuditMock.mockResolvedValue(scorecard("pass"));
    await expect(main(argv("run", "--baseline", "abc"))).resolves.toBe(EXIT.OK);
    const out = stdout.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain('"verdict": "pass"');
    expect(out).toContain('"schema_version": "1"');
  });

  it("a warn verdict → exit 0 (warn never blocks)", async () => {
    runAuditMock.mockResolvedValue(scorecard("warn"));
    await expect(main(argv("run", "--baseline", "abc"))).resolves.toBe(EXIT.OK);
  });

  it("a fail verdict → exit 1", async () => {
    runAuditMock.mockResolvedValue(scorecard("fail"));
    await expect(main(argv("run", "--baseline", "abc"))).resolves.toBe(EXIT.FAIL);
  });

  it("a thrown error from runAudit (e.g. no git) → exit 2", async () => {
    runAuditMock.mockRejectedValue(new Error("git rev-parse HEAD failed"));
    await expect(main(argv("run", "--baseline", "abc"))).resolves.toBe(EXIT.TOOL_ERROR);
  });

  it("forwards --baseline / --task / --trajectory to runAudit", async () => {
    runAuditMock.mockResolvedValue(scorecard("pass"));
    await main(argv("run", "--baseline", "sha1", "--task", "t.md", "--trajectory", "trace.jsonl"));
    expect(runAuditMock).toHaveBeenCalledWith({
      baselineSha: "sha1",
      taskPath: "t.md",
      trajectoryPath: "trace.jsonl",
    });
  });

  it("main never rejects, even on an unknown command", async () => {
    await expect(main(argv("bogus-command"))).resolves.toBe(EXIT.TOOL_ERROR);
  });

  it("--out writes scorecard.json to the given path", async () => {
    runAuditMock.mockResolvedValue(scorecard("pass"));
    const dir = await mkdtemp(join(tmpdir(), "blastcheck-cli-"));
    const outPath = join(dir, "scorecard.json");
    try {
      await expect(main(argv("run", "--baseline", "abc", "--out", outPath))).resolves.toBe(EXIT.OK);
      const written = await readFile(outPath, "utf8");
      expect(written).toContain('"verdict": "pass"');
      expect(written).toContain('"schema_version": "1"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a failed --out write does NOT mask the verdict exit code", async () => {
    runAuditMock.mockResolvedValue(scorecard("fail"));
    // Parent directory does not exist → writeFile rejects (ENOENT). The fail
    // verdict must still map to exit 1, not the tool-error exit 2.
    const bad = join(tmpdir(), "blastcheck-no-such-dir-xyz", "scorecard.json");
    await expect(main(argv("run", "--baseline", "abc", "--out", bad))).resolves.toBe(EXIT.FAIL);
  });

  it("--comment writes the PR-comment markdown (with marker) and nothing to stdout", async () => {
    runAuditMock.mockResolvedValue(scorecard("pass"));
    const dir = await mkdtemp(join(tmpdir(), "blastcheck-cli-"));
    const commentPath = join(dir, "comment.md");
    try {
      await expect(main(argv("run", "--baseline", "abc", "--comment", commentPath))).resolves.toBe(
        EXIT.OK,
      );
      const written = await readFile(commentPath, "utf8");
      // First line is the upsert marker the Action keys on.
      expect(written.startsWith("<!-- blastcheck-scorecard -->")).toBe(true);
      expect(written).toContain("PASS");
      // stdout still carries ONLY scorecard.json — never the comment markdown.
      const out = stdout.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain('"verdict": "pass"');
      expect(out).not.toContain("<!-- blastcheck-scorecard -->");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a failed --comment write does NOT mask the verdict exit code", async () => {
    runAuditMock.mockResolvedValue(scorecard("fail"));
    // Parent directory does not exist → writeFile rejects (ENOENT). The fail
    // verdict must still map to exit 1, not the tool-error exit 2 (mirror of --out).
    const bad = join(tmpdir(), "blastcheck-no-such-dir-xyz", "comment.md");
    await expect(main(argv("run", "--baseline", "abc", "--comment", bad))).resolves.toBe(EXIT.FAIL);
  });

  it("init routes to the default claude-code integration and exits 0", async () => {
    await expect(main(argv("init"))).resolves.toBe(EXIT.OK);
    expect(getIntegrationMock).toHaveBeenCalledWith("claude-code");
    expect(installMock).toHaveBeenCalledWith({ cwd: process.cwd() });
    const out = stdout.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toBe("");
  });

  it("init --agent claude-code routes to the claude-code integration", async () => {
    await expect(main(argv("init", "--agent", "claude-code"))).resolves.toBe(EXIT.OK);
    expect(getIntegrationMock).toHaveBeenCalledWith("claude-code");
    expect(installMock).toHaveBeenCalledWith({ cwd: process.cwd() });
    const out = stdout.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toBe("");
  });

  it("init --agent unknown exits 2, calls no installer, and writes nothing to stdout", async () => {
    await expect(main(argv("init", "--agent", "unknown"))).resolves.toBe(EXIT.TOOL_ERROR);
    expect(getIntegrationMock).not.toHaveBeenCalled();
    expect(installMock).not.toHaveBeenCalled();
    const out = stdout.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toBe("");
  });

  it("init --agent codex resolves the registry entry and exits 2 until implemented", async () => {
    installMock.mockRejectedValue(new Error("codex installer is not implemented yet"));
    await expect(main(argv("init", "--agent", "codex"))).resolves.toBe(EXIT.TOOL_ERROR);
    expect(getIntegrationMock).toHaveBeenCalledWith("codex");
    expect(installMock).toHaveBeenCalledWith({ cwd: process.cwd() });
    const out = stdout.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toBe("");
  });

  it("status routes through the status module, exits 0, and writes nothing to stdout", async () => {
    buildReadinessSnapshotMock.mockResolvedValue({
      integrations: [
        {
          agent: "claude-code",
          displayName: "Claude Code",
          configFiles: [{ path: ".gitignore", present: true }],
          trust: "trusted",
          evidence: "full",
          actionNeeded: "—",
        },
      ],
      trajectoryPresent: true,
      baselinePresent: true,
      warnings: [],
      supportedAgents: "claude-code, codex, opencode, github",
    });
    await expect(main(argv("status"))).resolves.toBe(EXIT.OK);
    expect(buildReadinessSnapshotMock).toHaveBeenCalledWith(process.cwd());
    expect(printReadinessMock).toHaveBeenCalledTimes(1);
    const out = stdout.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toBe("");
  });

  it("status with a needs-review codex entry still exits 0 and writes nothing to stdout", async () => {
    // A needs-review integration is a warning state, not a failure (FR41): the
    // read-only command stays exit 0 with a clean stdout regardless of trust.
    buildReadinessSnapshotMock.mockResolvedValue({
      integrations: [
        {
          agent: "codex",
          displayName: "Codex",
          configFiles: [{ path: ".codex/hooks.json", present: true }],
          trust: "needs-review",
          evidence: "pending",
          actionNeeded: "review hooks in Codex `/hooks`",
        },
      ],
      trajectoryPresent: false,
      baselinePresent: false,
      warnings: [],
      supportedAgents: "claude-code, codex, opencode, github",
    });
    await expect(main(argv("status"))).resolves.toBe(EXIT.OK);
    const out = stdout.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toBe("");
  });

  it("status with an unverified OpenCode runtime still exits 0 and writes nothing to stdout", async () => {
    // An unverified runtime is a warning, not a failure (FR40/FR41): the
    // read-only command stays exit 0 with a clean stdout (NFR5).
    buildReadinessSnapshotMock.mockResolvedValue({
      integrations: [
        {
          agent: "opencode",
          displayName: "OpenCode",
          configFiles: [{ path: ".opencode/plugins/blastcheck.ts", present: true }],
          trust: "trusted",
          evidence: "pending",
          runtime: "unverified",
          actionNeeded: "install/run OpenCode to verify the runtime",
        },
      ],
      trajectoryPresent: false,
      baselinePresent: false,
      warnings: [
        "opencode: plugin installed but OpenCode runtime not verified (`opencode` not found on PATH)",
      ],
      supportedAgents: "claude-code, codex, opencode, github",
    });
    await expect(main(argv("status"))).resolves.toBe(EXIT.OK);
    const out = stdout.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toBe("");
  });

  it("status on an empty manifest still exits 0 and writes nothing to stdout", async () => {
    // beforeEach default: empty integrations. The read-only command never fails.
    await expect(main(argv("status"))).resolves.toBe(EXIT.OK);
    expect(buildReadinessSnapshotMock).toHaveBeenCalledTimes(1);
    const out = stdout.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toBe("");
  });

  it("status never invokes an integration install() (read-only)", async () => {
    await expect(main(argv("status"))).resolves.toBe(EXIT.OK);
    expect(installMock).not.toHaveBeenCalled();
    expect(getIntegrationMock).not.toHaveBeenCalled();
  });

  it("hook stop maps the hook's exit code through to the process", async () => {
    runStopMock.mockResolvedValue(EXIT.FAIL);
    await expect(main(argv("hook", "stop"))).resolves.toBe(EXIT.FAIL);
    expect(runStopMock).toHaveBeenCalledTimes(1);
  });

  it("hook stop forwards the parsed stdin payload, its cwd, and the Claude Code reporter", async () => {
    readStdinMock.mockResolvedValue(JSON.stringify({ cwd: "/work", stop_hook_active: false }));
    runStopMock.mockResolvedValue(EXIT.OK);
    await main(argv("hook", "stop"));
    // Now also passes the per-agent reporter and resolved surfacing options.
    expect(runStopMock).toHaveBeenCalledWith(
      { cwd: "/work", stop_hook_active: false },
      "/work",
      expect.objectContaining({ surface: expect.any(Function) }),
      expect.objectContaining({ feedback: expect.any(Boolean), block: expect.any(Boolean) }),
    );
  });

  it("hook codex stop forwards the payload, its cwd, and the Codex reporter + surfacing options", async () => {
    readStdinMock.mockResolvedValue(JSON.stringify({ cwd: "/work", stop_hook_active: false }));
    runStopMock.mockResolvedValue(EXIT.OK);
    await main(argv("hook", "codex", "stop"));
    // Mirrors the Claude `hook stop` wiring: per-agent reporter + resolved options.
    expect(runStopMock).toHaveBeenCalledWith(
      { cwd: "/work", stop_hook_active: false },
      "/work",
      expect.objectContaining({ surface: expect.any(Function) }),
      expect.objectContaining({ feedback: expect.any(Boolean), block: expect.any(Boolean) }),
    );
  });

  it("hook codex stop maps the hook's exit code through to the process", async () => {
    runStopMock.mockResolvedValue(EXIT.FAIL);
    await expect(main(argv("hook", "codex", "stop"))).resolves.toBe(EXIT.FAIL);
  });

  it("hook session-start / post-tool-use invoke their handlers and exit 0", async () => {
    runSessionStartMock.mockResolvedValue(undefined);
    runPostToolUseMock.mockResolvedValue(undefined);
    await expect(main(argv("hook", "session-start"))).resolves.toBe(EXIT.OK);
    await expect(main(argv("hook", "post-tool-use"))).resolves.toBe(EXIT.OK);
    expect(runSessionStartMock).toHaveBeenCalledTimes(1);
    expect(runPostToolUseMock).toHaveBeenCalledTimes(1);
  });

  it("hook opencode stop routes to runStop and maps its exit code through (AC6)", async () => {
    // The plugin's `session.idle` shell-out invokes this exact space-separated
    // path; it must resolve to the agent-agnostic runStop and carry its code.
    readStdinMock.mockResolvedValue(JSON.stringify({ cwd: "/work" }));
    runStopMock.mockResolvedValue(EXIT.FAIL);
    await expect(main(argv("hook", "opencode", "stop"))).resolves.toBe(EXIT.FAIL);
    expect(runStopMock).toHaveBeenCalledWith({ cwd: "/work" }, "/work");
  });

  it("notify codex forwards the argv payload positional to runCodexNotify and exits 0", async () => {
    const payload = JSON.stringify({ type: "agent-turn-complete", cwd: "/work" });
    await expect(main(argv("notify", "codex", payload))).resolves.toBe(EXIT.OK);
    // Codex passes the event as an argv positional (NOT stdin) — assert it lands.
    expect(runCodexNotifyMock).toHaveBeenCalledWith(payload);
    expect(readStdinMock).not.toHaveBeenCalled();
  });

  it("notify codex still exits 0 even when the handler is a no-op (missing scorecard)", async () => {
    await expect(main(argv("notify", "codex", "{}"))).resolves.toBe(EXIT.OK);
    expect(runCodexNotifyMock).toHaveBeenCalledTimes(1);
  });

  // `adapt` runs the real adapter registry (not mocked) — it never touches runAudit.
  const codexFixture = join(
    process.cwd(),
    "tests/fixtures/trajectories/codex-rollout.sample.jsonl",
  );

  it("adapt --from codex writes common jsonl to stdout and exits 0", async () => {
    await expect(main(argv("adapt", "--from", "codex", codexFixture))).resolves.toBe(EXIT.OK);
    const out = stdout.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain('"tool":"shell"');
    expect(out).toContain('"cmd":"git status"');
    // honest degradation: snake_case external contract, one event per line
    expect(out.trim().split("\n").length).toBe(3);
    expect(runAuditMock).not.toHaveBeenCalled();
  });

  it("adapt with an unknown --from exits 2 and writes nothing to stdout", async () => {
    await expect(main(argv("adapt", "--from", "bogus", codexFixture))).resolves.toBe(
      EXIT.TOOL_ERROR,
    );
    const out = stdout.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toBe("");
  });

  it("adapt on an unreadable log file exits 2 (file-level read error)", async () => {
    const missing = join(tmpdir(), "blastcheck-no-such-log-xyz.jsonl");
    await expect(main(argv("adapt", "--from", "codex", missing))).resolves.toBe(EXIT.TOOL_ERROR);
  });
});
