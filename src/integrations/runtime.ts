/**
 * Read-only runtime detection for `blastcheck status` (Story 3.4 / FR40).
 *
 * Answers one question: "is an executable named `<bin>` resolvable on the
 * user's `PATH`?" — a deterministic, dependency-free proxy for "the runtime
 * that would load our plugin is installed and available." It is a pure
 * filesystem lookup: no process is ever spawned (`status` is read-only and must
 * not hang), no `which`/`command-exists` package is added (Node built-ins only
 * — NFR1), and any lookup error degrades the candidate to "not found" rather
 * than throwing (FR41).
 *
 * The optional `env` argument keeps the probe testable without depending on the
 * host's real `PATH`/installed binaries.
 */

import { access, constants as fsConstants, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";

const isWindows = process.platform === "win32";

/**
 * True when an executable named `bin` is resolvable on `env.PATH`.
 *
 * Scans each `PATH` entry for the bare name (POSIX) or the name plus a `PATHEXT`
 * extension (Windows). On POSIX the candidate must have its executable bit set
 * (`X_OK`); on Windows existence suffices (`access` ignores `X_OK` there). An
 * empty/undefined `PATH` or any per-candidate lookup error means "not found" —
 * the probe never throws (FR41).
 */
export async function isExecutableOnPath(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const rawPath = env.PATH;
  if (rawPath === undefined || rawPath.length === 0) return false;

  // POSIX: the bare name is the executable. Windows: try each PATHEXT extension.
  const candidates = isWindows ? windowsCandidates(bin, env) : [bin];

  for (const dir of rawPath.split(delimiter)) {
    if (dir.length === 0) continue;
    for (const candidate of candidates) {
      if (await isExecutableFile(join(dir, candidate))) return true;
    }
  }
  return false;
}

/** `<bin><ext>` for each Windows PATHEXT extension (best-effort portability). */
function windowsCandidates(bin: string, env: NodeJS.ProcessEnv): string[] {
  // Mirror the real Windows default (`.COM` first); treat an empty `PATHEXT`
  // the same as unset so we never collapse to the bare, extension-less name.
  const rawPathext = env.PATHEXT;
  const pathext = rawPathext && rawPathext.length > 0 ? rawPathext : ".COM;.EXE;.CMD;.BAT";
  const exts = pathext.split(";").filter((e) => e.length > 0);
  return exts.length > 0 ? exts.map((ext) => `${bin}${ext}`) : [bin];
}

/** True when `file` is a regular file and (on POSIX) executable; never throws. */
async function isExecutableFile(file: string): Promise<boolean> {
  try {
    // `access(X_OK)` succeeds on directories (the search bit), so a directory
    // named like the bin on PATH would be a false positive — require a regular
    // file first. `stat` follows symlinks, so a symlink to a file still matches.
    const stats = await stat(file);
    if (!stats.isFile()) return false;
    await access(file, isWindows ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
