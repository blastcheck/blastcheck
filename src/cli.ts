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
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import { runInit } from "./hooks/init.js";
import { runPostToolUse } from "./hooks/post-tool-use.js";
import { runSessionStart } from "./hooks/session-start.js";
import { parseHookPayload, readStdin } from "./hooks/state.js";
import { runStop } from "./hooks/stop.js";
import { runAudit } from "./index.js";
import { log, setVerbose } from "./log.js";
import { printScorecard } from "./scorecard/print.js";
import { EXIT, type ExitCode } from "./types.js";

const VERSION = "0.1.0";

/** Options Commander parses for the `run` subcommand. */
interface RunOptions {
  baseline: string;
  task?: string;
  out?: string;
  trajectory?: string;
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
    });

  // Distribution target #2 (Story 3.1): install the Claude Code hooks.
  program
    .command("init")
    .description("Install Claude Code hooks (trajectory capture + audit on Stop).")
    .option("-v, --verbose", "verbose (debug) logging to stderr")
    .action(async (opts: { verbose?: boolean }) => {
      setVerbose(Boolean(opts.verbose));
      await runInit({ cwd: process.cwd() });
    });

  // Hidden hook entrypoints invoked BY the installed hooks — they read the
  // Claude Code event payload from stdin. `hook stop` mirrors `run`'s contract
  // (scorecard → stdout, verdict → exit code); the others never touch stdout.
  const hook = program
    .command("hook")
    .description("Internal: Claude Code hook handlers (invoked via stdin).");

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
    .description("Stop handler: run the audit and emit scorecard.json to stdout.")
    .action(async () => {
      const payload = parseHookPayload(await readStdin());
      outcome.code = await runStop(payload, hookCwd(payload));
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
