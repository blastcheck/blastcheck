#!/usr/bin/env node
/**
 * CLI entry — a thin wrapper over the public `runAudit` API (AR9).
 *
 * Responsibilities only: parse argv, configure logging, and map outcomes to
 * exit codes (`0/1/2`, NFR10):
 *  - `scorecard.json` → `stdout` (the primary machine contract). The ONLY other
 *    thing Commander prints there is `--help`/`--version` (an allowed exception).
 *  - human-readable summary → `stderr` (via `printScorecard`).
 *  - `verdict === 'fail'` → exit `1`; `pass`/`warn` → exit `0` (warn never blocks,
 *    spec §4); any thrown exception (no git / `GitError`) → exit `2` (tool error).
 */

import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import { runCodexNotify } from "./hooks/notify.js";
import {
  runCodexPostToolUse,
  runOpencodePostToolUse,
  runPostToolUse,
} from "./hooks/post-tool-use.js";
import { runSessionStart } from "./hooks/session-start.js";
import { parseHookPayload, readStdin } from "./hooks/state.js";
import { runStop } from "./hooks/stop.js";
import { runAudit } from "./index.js";
import { getIntegration, isAgentId, supportedAgentsForMessage } from "./integrations/registry.js";
import { buildReadinessSnapshot, printReadiness } from "./integrations/status.js";
import { log, setVerbose } from "./log.js";
import { claudeCodeReporter } from "./reporters/claude-code.js";
import { codexReporter } from "./reporters/codex.js";
import { opencodeReporter } from "./reporters/opencode.js";
import { resolveSurfacingOptions } from "./reporters/options.js";
import { renderPrComment } from "./scorecard/markdown.js";
import { printScorecard } from "./scorecard/print.js";
import { adaptLogToJsonl } from "./trajectory/adapters/adapt.js";
import { isTrajectoryFormat, TRAJECTORY_FORMATS } from "./trajectory/adapters/index.js";
import { EXIT, type ExitCode } from "./types.js";

const VERSION = "0.1.0";

/** Options Commander parses for the `run` subcommand. */
interface RunOptions {
  baseline: string;
  task?: string;
  out?: string;
  comment?: string;
  trajectory?: string;
  verbose?: boolean;
}

interface InitOptions {
  agent?: string;
  verbose?: boolean;
}

/**
 * Carries the audit verdict's exit code back to {@link main}. A failed verdict
 * is NOT an exception (the tool ran fine) — it's a result, so the action records
 * it here rather than throwing (which would mis-map to the tool-error exit `2`).
 */
interface Outcome {
  code: ExitCode;
}

/** Build the Commander program (exported for testing). */
export function buildProgram(outcome: Outcome): Command {
  const program = new Command();
  program
    .name("blastcheck")
    .description("Audit AI coding-agent changes against a contract.")
    .version(VERSION, "-V, --version");

  program
    .command("run")
    .description("Run an audit and emit scorecard.json to stdout.")
    .requiredOption("--baseline <sha>", "pre-run commit to audit against (required)")
    .option("--task <path>", "task file (reserved; v1 reads baseline:task.md)")
    .option("--out <path>", "also write scorecard.json to this file")
    .option("--comment <path>", "also write the PR-comment markdown to this file")
    .option("--trajectory <path>", "agent trajectory JSONL")
    .option("-v, --verbose", "verbose (debug) logging to stderr")
    .action(async (opts: RunOptions) => {
      setVerbose(Boolean(opts.verbose));

      const scorecard = await runAudit({
        baselineSha: opts.baseline,
        taskPath: opts.task,
        trajectoryPath: opts.trajectory,
      });

      // stdout: the machine contract, and nothing else.
      const json = `${JSON.stringify(scorecard, null, 2)}\n`;
      process.stdout.write(json);

      // stderr: the human-readable summary.
      printScorecard(scorecard);

      // warn never blocks (spec §4) — only a fail verdict exits non-zero.
      // Decide the exit code from the verdict BEFORE the optional `--out` write,
      // so an I/O failure on that side channel can't discard a valid scorecard.
      outcome.code = scorecard.verdict === "fail" ? EXIT.FAIL : EXIT.OK;

      // `--out` is an optional convenience mirror of stdout. A write failure is
      // logged to stderr but must NOT override the audit's verdict exit code
      // (the scorecard is already on stdout) or mis-map to a tool error.
      if (opts.out !== undefined) {
        try {
          await writeFile(opts.out, json, "utf8");
        } catch (err) {
          log(
            "error",
            `failed to write --out ${opts.out}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // `--comment` is the side channel the GitHub Action consumes: the same
      // scorecard rendered as PR-comment markdown. Like `--out`, it is written
      // AFTER the verdict code is set and a write failure is logged but must NOT
      // override the exit code or touch stdout (stdout stays scorecard.json only).
      if (opts.comment !== undefined) {
        try {
          await writeFile(opts.comment, renderPrComment(scorecard), "utf8");
        } catch (err) {
          log(
            "error",
            `failed to write --comment ${opts.comment}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    });

  // Cross-agent adapters (Story 4.1): convert a native Codex/Cursor/Aider log
  // into the common trajectory JSONL on stdout. A separate transformation
  // utility — NOT part of the audit path (AR9): the user pipes its output into
  // `run --trajectory`. Diagnostics/errors go to stderr; the common jsonl is the
  // only thing on stdout.
  program
    .command("adapt")
    .description("Convert a native agent log to the common trajectory.jsonl (stdout).")
    .requiredOption("--from <format>", `native log format: ${TRAJECTORY_FORMATS.join(" | ")}`)
    .argument("<log-path>", "path to the native agent log file")
    .option("-v, --verbose", "verbose (debug) logging to stderr")
    .action(async (logPath: string, opts: { from: string; verbose?: boolean }) => {
      setVerbose(Boolean(opts.verbose));

      if (!isTrajectoryFormat(opts.from)) {
        log(
          "error",
          `unknown --from '${opts.from}'; expected one of: ${TRAJECTORY_FORMATS.join(", ")}`,
        );
        outcome.code = EXIT.TOOL_ERROR;
        return;
      }

      // A file-level read error throws → caught in `main` → exit 2 (like the
      // loader). Per-record problems are degraded to stderr inside the adapter.
      const raw = await readFile(logPath, "utf8");
      const jsonl = adaptLogToJsonl(opts.from, raw);
      process.stdout.write(jsonl);
      // Empty stdout is a successful-but-empty conversion (no tool calls in the
      // log). Surface it on stderr so it's not mistaken for a normal conversion.
      if (jsonl === "") {
        log("warn", `adapt: no events extracted from ${logPath} (0 tool calls) — output is empty`);
      }
      outcome.code = EXIT.OK;
    });

  // Installer-first entrypoint: route selected agents through the shared
  // integration registry. No --agent preserves existing Claude Code behavior.
  program
    .command("init")
    .description("Install blastcheck for a supported agent integration.")
    .option("--agent <agent>", `agent integration: ${supportedAgentsForMessage()}`)
    .option("-v, --verbose", "verbose (debug) logging to stderr")
    .action(async (opts: InitOptions) => {
      setVerbose(Boolean(opts.verbose));
      const agent = opts.agent ?? "claude-code";
      if (!isAgentId(agent)) {
        log("error", `unknown agent '${agent}'; supported agents: ${supportedAgentsForMessage()}`);
        outcome.code = EXIT.TOOL_ERROR;
        return;
      }
      const integration = getIntegration(agent);
      await integration.install({ cwd: process.cwd() });
    });

  // Read-only readiness report (Story 1.4): is blastcheck actually connected
  // here? Reads the manifest + `.blastcheck/` evidence and prints a concise
  // summary to STDERR only — stdout stays empty so it never collides with the
  // scorecard JSON contract other commands emit (NFR5). Missing binaries/config
  // are warnings, not failures, so it always exits 0 (FR41); only an unexpected
  // exception bubbling to `main` becomes a tool error (exit 2).
  program
    .command("status")
    .description("Report installed integrations, evidence, and readiness (stderr).")
    .option("-v, --verbose", "verbose (debug) logging to stderr")
    .action(async (opts: { verbose?: boolean }) => {
      setVerbose(Boolean(opts.verbose));
      const snapshot = await buildReadinessSnapshot(process.cwd());
      printReadiness(snapshot);
      outcome.code = EXIT.OK;
    });

  // Hidden hook entrypoints invoked BY the installed hooks — they read the
  // agent's event payload from stdin. `hook stop` mirrors `run`'s contract
  // (scorecard → stdout, verdict → exit code); the others never touch stdout.
  const hook = program
    .command("hook")
    .description("Internal: Claude Code / Codex hook handlers (invoked via stdin).");

  hook
    .command("session-start")
    .description("SessionStart handler: record the pre-commitment reference.")
    .action(async () => {
      const payload = parseHookPayload(await readStdin());
      await runSessionStart(payload, hookCwd(payload));
    });

  hook
    .command("post-tool-use")
    .description("PostToolUse handler: append the normalized trajectory event.")
    .action(async () => {
      const payload = parseHookPayload(await readStdin());
      await runPostToolUse(payload, hookCwd(payload));
    });

  hook
    .command("stop")
    .description("Stop handler: run the audit and surface the verdict to Claude Code.")
    .action(async () => {
      const payload = parseHookPayload(await readStdin());
      const cwd = hookCwd(payload);
      // Claude Code reporter: the verdict rides in the hook JSON (systemMessage +
      // fail alert), not the swallowed raw scorecard. The scorecard mirror stays
      // the source of truth (written by runStop before the reporter runs).
      outcome.code = await runStop(
        payload,
        cwd,
        claudeCodeReporter,
        await resolveSurfacingOptions(cwd),
      );
    });

  // Codex lifecycle handlers (Story 2.2), invoked by the `.codex/hooks.json`
  // command strings Story 2.1 installed — `blastcheck hook codex <name>`
  // (space-separated), so a NESTED `codex` sub-group is required to match the
  // exact paths the installer wrote. SessionStart/Stop reuse the agent-agnostic
  // handlers verbatim (Codex payloads are field-compatible); only post-tool-use
  // swaps in the Codex lifecycle adapter.
  const codex = hook
    .command("codex")
    .description("Internal: Codex lifecycle hook handlers (invoked via stdin).");

  codex
    .command("session-start")
    .description("Codex SessionStart handler: record the pre-commitment reference.")
    .action(async () => {
      const payload = parseHookPayload(await readStdin());
      await runSessionStart(payload, hookCwd(payload));
    });

  codex
    .command("post-tool-use")
    .description("Codex PostToolUse handler: append the normalized trajectory event.")
    .action(async () => {
      const payload = parseHookPayload(await readStdin());
      await runCodexPostToolUse(payload, hookCwd(payload));
    });

  codex
    .command("stop")
    .description("Codex Stop handler: run the audit and surface the verdict to Codex.")
    .action(async () => {
      const payload = parseHookPayload(await readStdin());
      const cwd = hookCwd(payload);
      // Codex reporter: the verdict rides in the Stop hook JSON (`systemMessage`,
      // plus opt-in feedback/block), NOT the swallowed raw scorecard. The `fail`
      // desktop alert is decoupled into the user-level `notify` program. The
      // scorecard mirror stays the source of truth (written by runStop first).
      outcome.code = await runStop(payload, cwd, codexReporter, await resolveSurfacingOptions(cwd));
    });

  // OpenCode lifecycle handlers (Story 3.2 capture + Story 3.3 audit), invoked by
  // the generated `.opencode/plugins/blastcheck.ts` — `blastcheck hook opencode
  // <event>` (space-separated), so a NESTED `opencode` sub-group is required to
  // match the exact paths the plugin shells out to. session-start + post-tool-use
  // CAPTURE the canonical trajectory; `stop` (the audit-on-idle/end trigger,
  // Story 3.3) runs the audit through the shared `runStop`. SessionStart/Stop reuse
  // the agent-agnostic handlers verbatim; post-tool-use uses the DEFAULT adapter
  // (the plugin pre-shapes the payload Claude-compatibly). Only `stop` writes
  // stdout (the scorecard, NFR9); session-start/post-tool-use stay silent (NFR5).
  const opencode = hook
    .command("opencode")
    .description("Internal: OpenCode plugin lifecycle hook handlers (invoked via stdin).");

  opencode
    .command("session-start")
    .description("OpenCode session-start handler: record the pre-commitment reference.")
    .action(async () => {
      const payload = parseHookPayload(await readStdin());
      await runSessionStart(payload, hookCwd(payload));
    });

  opencode
    .command("post-tool-use")
    .description("OpenCode post-tool-use handler: append the normalized trajectory event.")
    .action(async () => {
      const payload = parseHookPayload(await readStdin());
      await runOpencodePostToolUse(payload, hookCwd(payload));
    });

  opencode
    .command("stop")
    .description(
      "OpenCode session-idle/end handler: run the audit and surface the verdict to OpenCode.",
    )
    .action(async () => {
      const payload = parseHookPayload(await readStdin());
      const cwd = hookCwd(payload);
      // OpenCode reporter: the verdict rides in a surface JSON line on stdout
      // ({ message, variant, feedback? }) that the plugin's session.idle handler
      // captures and renders via the typed `client` (toast + opt-in feedback);
      // the `fail` desktop alert fires here CLI-side. The scorecard mirror stays
      // the source of truth (written by runStop first). Always exits OK — the
      // plugin shells `.nothrow()` and discards the code.
      outcome.code = await runStop(
        payload,
        cwd,
        opencodeReporter,
        await resolveSurfacingOptions(cwd),
      );
    });

  // User-level notify programs (Story 1.2). Unlike the `hook` entrypoints (which
  // read stdin), an agent runtime invokes these with the event payload as the
  // final argv positional. `codex` is Codex's `agent-turn-complete` notify
  // target: it desktop-alerts on a `fail` scorecard and is a silent no-op
  // otherwise. ALWAYS exit 0 — `notify` fires for every project on the machine.
  const notify = program
    .command("notify")
    .description("Internal: user-level notify programs (invoked by the agent runtime via argv).");

  notify
    .command("codex")
    .description("Codex agent-turn-complete notify: desktop-alert on a fail verdict.")
    .argument("<payload>", "the agent-turn-complete event payload JSON (passed by Codex as argv)")
    .action(async (payload: string) => {
      await runCodexNotify(payload);
      outcome.code = EXIT.OK;
    });

  return program;
}

/** Resolve the repo dir for a hook: the payload's `cwd`, else `process.cwd()`. */
function hookCwd(payload: Record<string, unknown> | undefined): string {
  return typeof payload?.cwd === "string" ? payload.cwd : process.cwd();
}

/** Parse argv and resolve to an exit code. Never throws. */
export async function main(argv: string[]): Promise<ExitCode> {
  // Default to OK; the `run` action overwrites it with the verdict's code.
  const outcome: Outcome = { code: EXIT.OK };
  const program = buildProgram(outcome);
  // Throw instead of calling process.exit so we own every exit code.
  program.exitOverride();
  try {
    await program.parseAsync(argv);
    return outcome.code;
  } catch (err) {
    if (err instanceof CommanderError) {
      // --help / --version write to stdout and are a successful exit.
      if (err.exitCode === 0) return EXIT.OK;
      // Usage errors (unknown option/command, missing required option):
      // Commander already wrote the message to stderr — don't duplicate it.
      return EXIT.TOOL_ERROR;
    }
    // Any other exception (e.g. git failure) → tool error.
    log("error", err instanceof Error ? err.message : String(err));
    return EXIT.TOOL_ERROR;
  }
}

/**
 * True when this module is the process entry point (run as the `blastcheck`
 * bin), false when it is merely imported (e.g. by `cli.test.ts`). `argv[1]` may
 * be a symlink (npm's `.bin` shim), so it is realpath'd before comparison.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

// Auto-run ONLY as the CLI entry — importing for tests must not execute it.
if (isMainModule()) {
  main(process.argv).then((code) => {
    process.exitCode = code;
  });
}
