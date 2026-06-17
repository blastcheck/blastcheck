import type { TrajectoryEvent } from "../types.js";

export interface EventSignature {
  kind: "path" | "cmd" | "recon" | "args";
  tool: string;
  key: string;
}

const SHELL_TOOLS = new Set(["bash", "shell"]);
const RECON_COMMANDS = new Set(["git status", "ls", "pwd", "cat"]);

function normalizeCmd(cmd: string): string {
  return cmd.trim().replace(/\s+/g, " ");
}

function isShellTool(tool: string): boolean {
  return SHELL_TOOLS.has(tool.toLowerCase());
}

function isReconCommand(cmd: string): boolean {
  const lower = cmd.toLowerCase();
  if (RECON_COMMANDS.has(lower)) return true;
  return lower.startsWith("cat ") && !/[|&;<>()]|\s(?:>|>>|<|<<)\s?/.test(cmd);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const next = (value as Record<string, unknown>)[key];
    if (next !== undefined) out[key] = canonicalize(next);
  }
  return out;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * A stable string key for an {@link EventSignature}, for use as a Map/Set key
 * where structural `{kind,tool,key}` equality is needed (redundancy counting in
 * `extraneous-tool-calls`, action-loop counting in `loop-detection`). The `\0`
 * separator cannot occur in any field, so distinct signatures never collide.
 */
export function signatureKey(sig: EventSignature): string {
  return `${sig.kind}\0${sig.tool}\0${sig.key}`;
}

export function signature(event: TrajectoryEvent): EventSignature {
  if (event.args.path !== undefined) {
    return { kind: "path", tool: event.tool, key: event.args.path };
  }

  if (event.args.cmd !== undefined && isShellTool(event.tool)) {
    const cmd = normalizeCmd(event.args.cmd);
    return {
      kind: isReconCommand(cmd) ? "recon" : "cmd",
      tool: event.tool.toLowerCase(),
      key: cmd,
    };
  }

  return { kind: "args", tool: event.tool, key: canonicalJson(event.args) };
}
