/**
 * Git adapter (AR3).
 *
 * Thin shell-out to the system `git` via `execFile` (NOT `exec` — array args,
 * no shell, no injection). No `isomorphic-git`. Every returned path is run
 * through `normalize()`.
 *
 * Error policy (consistency rule #6):
 *  - A missing `task.md` at a valid sha is a SIGNAL → `showTaskMd` returns null.
 *  - Unrecoverable failures (no git repo, unreadable `baseline_sha`) THROW a
 *    {@link GitError}, which `cli.ts` maps to exit `2`. `2 !== audit failure`.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "../log.js";
import { normalize } from "../match/normalize.js";
import type { DiffEntry } from "../types.js";

const execFileAsync = promisify(execFile);

// git output for large repos can exceed the default 1 MiB buffer.
const MAX_BUFFER = 64 * 1024 * 1024;

// Force a stable C locale so git diagnostics are English — `isMissingPathError`
// matches on message substrings, which would break under a localized git.
const GIT_ENV = { ...process.env, LANG: "C", LC_ALL: "C" };

/** Thrown for unrecoverable git failures (no repo / unreadable sha). */
export class GitError extends Error {
  override readonly name = "GitError";
}

export interface GitOptions {
  /** Working directory for the git invocation. Defaults to `process.cwd()`. */
  cwd?: string;
}

interface ExecError {
  stderr?: string | Buffer;
  stdout?: string | Buffer;
}

/** Run git and translate ANY failure into a {@link GitError}. */
async function runGit(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: MAX_BUFFER,
      env: GIT_ENV,
    });
    return stdout;
  } catch (err) {
    throw new GitError(`git ${args.join(" ")} failed`, { cause: err });
  }
}

/** A "path does not exist in <tree>" failure — a signal, not a tool error. */
function isMissingPathError(err: unknown): boolean {
  const stderr = (err as ExecError)?.stderr;
  const text = typeof stderr === "string" ? stderr : (stderr?.toString("utf8") ?? "");
  return text.includes("does not exist") || text.includes("exists on disk, but not in");
}

/**
 * `git diff --numstat -z <sha>` → `{ path, added, removed }[]`.
 *
 * `-z` makes paths NUL-delimited and verbatim, and `core.quotepath=false` keeps
 * non-ASCII bytes unescaped — so unicode paths, embedded tabs/newlines, and
 * renames (`old => new`) all parse correctly instead of yielding garbage paths.
 * `added`/`removed` are `null` for binary files (git prints `-`).
 */
export async function diffNumstat(sha: string, opts: GitOptions = {}): Promise<DiffEntry[]> {
  const stdout = await runGit(
    ["-c", "core.quotepath=false", "diff", "--numstat", "-z", sha],
    opts.cwd,
  );
  return parseNumstat(stdout);
}

/**
 * `git diff <sha>` → the full unified patch text (baseline → working tree).
 *
 * `core.quotepath=false` keeps non-ASCII path bytes unescaped so the patch is a
 * stable, faithful image of the changed surface — it is hashed (not parsed) to
 * fingerprint the worktree for state-dedup (Story 1.1). No-repo / bad-sha throw
 * {@link GitError}, like the other adapter primitives.
 */
export async function diffPatch(sha: string, opts: GitOptions = {}): Promise<string> {
  return runGit(["-c", "core.quotepath=false", "diff", sha], opts.cwd);
}

/**
 * `git show <sha>:task.md` → file content, or `null` when the file does not
 * exist at that sha (a signal). No-repo / bad-sha still throw {@link GitError}.
 */
export async function showTaskMd(sha: string, opts: GitOptions = {}): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["show", `${sha}:task.md`], {
      cwd: opts.cwd,
      maxBuffer: MAX_BUFFER,
      env: GIT_ENV,
    });
    return stdout;
  } catch (err) {
    if (isMissingPathError(err)) return null;
    throw new GitError(`git show ${sha}:task.md failed`, { cause: err });
  }
}

/**
 * `git rev-parse HEAD` → the current commit sha (the agent's post-run state, the
 * far end of the audited range). Recorded in the scorecard as `head_sha`.
 *
 * Unrecoverable like the rest of the adapter: no repo / detached-empty HEAD →
 * {@link GitError} → exit `2`. The trailing newline is trimmed.
 */
export async function headSha(opts: GitOptions = {}): Promise<string> {
  const stdout = await runGit(["rev-parse", "HEAD"], opts.cwd);
  return stdout.trim();
}

/**
 * `git ls-files -z` → number of tracked files (repo size at baseline).
 * `-z` NUL-delimits entries so paths containing newlines are counted once.
 */
export async function lsFiles(opts: GitOptions = {}): Promise<number> {
  const stdout = await runGit(["ls-files", "-z"], opts.cwd);
  let count = 0;
  for (const entry of stdout.split("\0")) {
    if (entry.length > 0) count++;
  }
  return count;
}

/** A count column: `-` (binary) or a non-integer token → `null`, else the int. */
function parseCount(raw: string): number | null {
  if (raw === "-") return null;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * Parse `git diff --numstat -z` output into normalized {@link DiffEntry} rows.
 *
 * Records are NUL-delimited tokens. A normal change is a single token
 * `added\tremoved\tpath`; a rename/copy is a token `added\tremoved\t` (empty
 * inline path) FOLLOWED by two tokens `<old>` and `<new>` — we keep `<new>`.
 */
function parseNumstat(stdout: string): DiffEntry[] {
  const tokens = stdout.split("\0");
  const entries: DiffEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok === undefined || tok === "") {
      i++;
      continue;
    }
    const firstTab = tok.indexOf("\t");
    const secondTab = firstTab < 0 ? -1 : tok.indexOf("\t", firstTab + 1);
    if (secondTab < 0) {
      // Malformed record — skip but leave a trace rather than failing silently.
      log("debug", `git numstat: unparseable record ${JSON.stringify(tok)}`);
      i++;
      continue;
    }
    const addedRaw = tok.slice(0, firstTab);
    const removedRaw = tok.slice(firstTab + 1, secondTab);
    const inlinePath = tok.slice(secondTab + 1);

    let path: string;
    if (inlinePath !== "") {
      path = inlinePath;
      i += 1;
    } else {
      // Rename/copy: next two tokens are <old> then <new>; keep the new path.
      path = tokens[i + 2] ?? "";
      i += 3;
    }
    if (path === "") continue;
    entries.push({
      path: normalize(path),
      added: parseCount(addedRaw),
      removed: parseCount(removedRaw),
    });
  }
  return entries;
}
