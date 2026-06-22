import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildReadinessSnapshot, renderReadiness } from "./status.js";
import type { InstallTrustState } from "./types.js";

/** Minimal manifest entry in the external (snake_case) shape the reader expects. */
interface ExternalEntry {
  agent: string;
  display_name?: string;
  config_files?: string[];
  evidence_paths?: Record<string, string>;
  trust?: InstallTrustState;
  updated_at?: string;
}

describe("status readiness snapshot", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "blastcheck-status-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** Write `.blastcheck/install.json` for the given external entries. */
  async function writeManifest(...entries: ExternalEntry[]): Promise<void> {
    await mkdir(join(dir, ".blastcheck"), { recursive: true });
    const integrations: Record<string, ExternalEntry> = {};
    for (const e of entries) {
      integrations[e.agent] = {
        agent: e.agent,
        config_files: e.config_files ?? [],
        // Default to the canonical paths the real claude-code installer records,
        // so global trajectory/baseline written by a test resolve per-integration.
        evidence_paths: e.evidence_paths ?? {
          trajectory: ".blastcheck/trajectory.jsonl",
          baseline: ".blastcheck/baseline",
          scorecard: ".blastcheck/scorecard.json",
        },
        updated_at: e.updated_at ?? "2026-06-20T00:00:00.000Z",
        ...(e.display_name === undefined ? {} : { display_name: e.display_name }),
        ...(e.trust === undefined ? {} : { trust: e.trust }),
      };
    }
    await writeFile(
      join(dir, ".blastcheck", "install.json"),
      `${JSON.stringify({ schema_version: "1", integrations }, null, 2)}\n`,
      "utf8",
    );
  }

  /** Write a `.blastcheck/` evidence file with content. */
  async function writeState(name: string, content: string): Promise<void> {
    await mkdir(join(dir, ".blastcheck"), { recursive: true });
    await writeFile(join(dir, ".blastcheck", name), content, "utf8");
  }

  it("reports an empty manifest as a normal, installed-nothing state", async () => {
    const snapshot = await buildReadinessSnapshot(dir);
    expect(snapshot.integrations).toEqual([]);
    const out = renderReadiness(snapshot).join("\n");
    expect(out).toContain("no integrations installed");
    expect(out).toContain("blastcheck init --agent");
    expect(out).toContain("claude-code");
  });

  it("reports a trusted integration with full evidence and no action", async () => {
    await writeManifest({
      agent: "claude-code",
      display_name: "Claude Code",
      config_files: [".claude/settings.json", ".gitignore"],
      trust: "trusted",
    });
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(join(dir, ".claude", "settings.json"), "{}", "utf8");
    await writeFile(join(dir, ".gitignore"), ".blastcheck/\n", "utf8");
    await writeState("trajectory.jsonl", '{"tool":"x"}\n');
    await writeState("baseline", "abc123\n");

    const snapshot = await buildReadinessSnapshot(dir);
    expect(snapshot.integrations).toHaveLength(1);
    const cc = snapshot.integrations[0];
    expect(cc.agent).toBe("claude-code");
    expect(cc.displayName).toBe("Claude Code");
    expect(cc.evidence).toBe("full");
    expect(cc.trust).toBe("trusted");
    expect(cc.actionNeeded).toBe("—");
    expect(cc.configFiles.every((c) => c.present)).toBe(true);
    expect(snapshot.warnings).toEqual([]);
  });

  it("marks pending evidence when config is present but no session has run", async () => {
    await writeManifest({
      agent: "claude-code",
      config_files: [".claude/settings.json"],
      trust: "trusted",
    });
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(join(dir, ".claude", "settings.json"), "{}", "utf8");

    const snapshot = await buildReadinessSnapshot(dir);
    expect(snapshot.integrations[0].evidence).toBe("pending");
    expect(snapshot.integrations[0].actionNeeded).toContain("capture a trajectory");
  });

  it("marks git-only evidence when a baseline exists but no trajectory", async () => {
    await writeManifest({
      agent: "claude-code",
      config_files: [".claude/settings.json"],
      trust: "trusted",
    });
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(join(dir, ".claude", "settings.json"), "{}", "utf8");
    await writeState("baseline", "abc123\n");

    const snapshot = await buildReadinessSnapshot(dir);
    expect(snapshot.integrations[0].evidence).toBe("git-only");
  });

  it("warns (not fails) on a recorded-but-missing config file with an actionable step", async () => {
    await writeManifest({
      agent: "claude-code",
      config_files: [".claude/settings.json", ".gitignore"],
      trust: "trusted",
    });
    // Only one of the two recorded files exists on disk.
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(join(dir, ".claude", "settings.json"), "{}", "utf8");

    const snapshot = await buildReadinessSnapshot(dir);
    const cc = snapshot.integrations[0];
    const missing = cc.configFiles.find((c) => c.path === ".gitignore");
    expect(missing?.present).toBe(false);
    expect(cc.actionNeeded).toContain("blastcheck init --agent claude-code");
    expect(snapshot.warnings.some((w) => w.includes(".gitignore"))).toBe(true);
  });

  it("points a needs-review Codex entry at the `/hooks` trust review (UX-DR4)", async () => {
    await writeManifest({
      agent: "codex",
      display_name: "Codex",
      config_files: [".codex/hooks.json"],
      trust: "needs-review",
    });
    await mkdir(join(dir, ".codex"), { recursive: true });
    await writeFile(join(dir, ".codex", "hooks.json"), "{}", "utf8");

    const snapshot = await buildReadinessSnapshot(dir);
    const codex = snapshot.integrations[0];
    // Installed but NOT fully ready: explicit trust state, never plain "ready".
    expect(codex.trust).toBe("needs-review");
    expect(codex.evidence).not.toBe("full");
    expect(codex.actionNeeded).toBe("review hooks in Codex `/hooks`");
    // A needs-review integration is a warning state, not a failure.
    expect(snapshot.warnings).toEqual([]);
  });

  it("keeps a generic trust-review action for a non-Codex needs-review entry", async () => {
    await writeManifest({
      agent: "opencode",
      display_name: "OpenCode",
      config_files: [],
      trust: "needs-review",
    });
    const snapshot = await buildReadinessSnapshot(dir);
    expect(snapshot.integrations[0].actionNeeded).toBe("run trust review for opencode");
  });

  it("degrades a present-but-malformed scorecard to a warning without throwing", async () => {
    await writeManifest({
      agent: "claude-code",
      config_files: [".claude/settings.json"],
      trust: "trusted",
    });
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(join(dir, ".claude", "settings.json"), "{}", "utf8");
    await writeState("scorecard.json", "{ not json");

    const snapshot = await buildReadinessSnapshot(dir);
    expect(snapshot.scorecard?.unreadable).toBe(true);
    expect(snapshot.warnings.some((w) => w.includes("scorecard"))).toBe(true);
  });

  it("surfaces a valid scorecard's project-relative path and verdict", async () => {
    await writeManifest({
      agent: "claude-code",
      config_files: [".claude/settings.json"],
      trust: "trusted",
    });
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(join(dir, ".claude", "settings.json"), "{}", "utf8");
    await writeState("baseline", "abc\n");
    await writeState("trajectory.jsonl", '{"tool":"x"}\n');
    await writeState("scorecard.json", JSON.stringify({ verdict: "pass" }));

    const snapshot = await buildReadinessSnapshot(dir);
    expect(snapshot.scorecard?.verdict).toBe("pass");
    expect(snapshot.scorecard?.path).toBe(".blastcheck/scorecard.json");
    const out = renderReadiness(snapshot).join("\n");
    expect(out).toContain("verdict: pass");
  });

  it("renders the readiness matrix labels for a snapshot-lite assertion", async () => {
    await writeManifest({
      agent: "claude-code",
      display_name: "Claude Code",
      config_files: [".claude/settings.json"],
      trust: "trusted",
    });
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(join(dir, ".claude", "settings.json"), "{}", "utf8");
    await writeState("baseline", "abc\n");
    await writeState("trajectory.jsonl", '{"tool":"x"}\n');

    const out = renderReadiness(await buildReadinessSnapshot(dir)).join("\n");
    expect(out).toContain("integrations:");
    expect(out).toContain("evidence:");
    expect(out).toContain("action:");
    expect(out).toContain("claude-code");
  });

  it("attributes evidence per integration, not repo-wide", async () => {
    // The shared `.blastcheck/` evidence exists, but only `claude-code` records
    // paths pointing at it; the second integration recorded no evidence paths
    // and must NOT inherit the first integration's trajectory/baseline.
    await writeManifest(
      {
        agent: "claude-code",
        display_name: "Claude Code",
        config_files: [".claude/settings.json"],
        trust: "trusted",
      },
      {
        agent: "codex",
        display_name: "Codex",
        config_files: [".codex/config.toml"],
        trust: "trusted",
        evidence_paths: {}, // never ran → no recorded evidence of its own
      },
    );
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(join(dir, ".claude", "settings.json"), "{}", "utf8");
    await mkdir(join(dir, ".codex"), { recursive: true });
    await writeFile(join(dir, ".codex", "config.toml"), "", "utf8");
    await writeState("baseline", "abc\n");
    await writeState("trajectory.jsonl", '{"tool":"x"}\n');

    const snapshot = await buildReadinessSnapshot(dir);
    const byAgent = Object.fromEntries(snapshot.integrations.map((i) => [i.agent, i]));
    expect(byAgent["claude-code"].evidence).toBe("full");
    expect(byAgent.codex.evidence).toBe("pending");
  });

  /** Write the OpenCode manifest entry with its plugin config file on disk. */
  async function writeOpencodeInstall(): Promise<void> {
    await writeManifest({
      agent: "opencode",
      display_name: "OpenCode",
      config_files: [".opencode/plugins/blastcheck.ts"],
      trust: "trusted",
    });
    await mkdir(join(dir, ".opencode", "plugins"), { recursive: true });
    await writeFile(join(dir, ".opencode", "plugins", "blastcheck.ts"), "// plugin\n", "utf8");
  }

  it("flags an unverified OpenCode runtime as a warning, not a failure (FR40/FR41)", async () => {
    await writeOpencodeInstall();
    const snapshot = await buildReadinessSnapshot(dir, { detectRuntime: async () => false });

    const oc = snapshot.integrations[0];
    expect(oc.agent).toBe("opencode");
    expect(oc.runtime).toBe("unverified");
    // Evidence is computed independently of runtime (AC2): config present, no
    // session → pending, NOT conflated with the runtime miss.
    expect(oc.evidence).toBe("pending");
    expect(oc.actionNeeded).toBe("install/run OpenCode to verify the runtime");
    expect(
      snapshot.warnings.some((w) => w.includes("runtime not verified") && w.includes("PATH")),
    ).toBe(true);
    const out = renderReadiness(snapshot).join("\n");
    expect(out).toContain("runtime: not verified");
  });

  it("reports a verified runtime with evidence still computed separately (AC2)", async () => {
    await writeOpencodeInstall();
    const snapshot = await buildReadinessSnapshot(dir, { detectRuntime: async () => true });

    const oc = snapshot.integrations[0];
    expect(oc.runtime).toBe("verified");
    // A verified runtime with no captured session is STILL pending evidence.
    expect(oc.evidence).toBe("pending");
    expect(snapshot.warnings).toEqual([]);
    const out = renderReadiness(snapshot).join("\n");
    expect(out).toContain("runtime: verified");
  });

  it("keeps evidence: full independent of a verified runtime", async () => {
    await writeOpencodeInstall();
    await writeState("trajectory.jsonl", '{"tool":"x"}\n');
    await writeState("baseline", "abc123\n");

    const snapshot = await buildReadinessSnapshot(dir, { detectRuntime: async () => true });
    const oc = snapshot.integrations[0];
    expect(oc.runtime).toBe("verified");
    expect(oc.evidence).toBe("full");
    expect(oc.actionNeeded).toBe("—");
  });

  it("never annotates a non-OpenCode row with a runtime token (AC4 regression)", async () => {
    await writeManifest(
      {
        agent: "claude-code",
        display_name: "Claude Code",
        config_files: [".claude/settings.json"],
        trust: "trusted",
      },
      {
        agent: "codex",
        display_name: "Codex",
        config_files: [".codex/hooks.json"],
        trust: "trusted",
      },
    );
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(join(dir, ".claude", "settings.json"), "{}", "utf8");
    await mkdir(join(dir, ".codex"), { recursive: true });
    await writeFile(join(dir, ".codex", "hooks.json"), "{}", "utf8");

    // The detector would resolve true for any agent, but only OpenCode is probed.
    const snapshot = await buildReadinessSnapshot(dir, { detectRuntime: async () => true });
    for (const it of snapshot.integrations) {
      expect(it.runtime).toBeUndefined();
    }
    const out = renderReadiness(snapshot).join("\n");
    expect(out).not.toContain("runtime:");
  });
});
