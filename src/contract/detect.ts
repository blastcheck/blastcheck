/**
 * Autodetect `required_checks` from repo manifests (FR5, spec §2.5).
 *
 * Only QA signals are extracted — `test` / `lint` / `typecheck`. Operational
 * scripts (`build` / `dev` / `start` / `format` / `serve` / `watch` / `clean`)
 * are NOT QA gates and are excluded, even when they appear as a sub-token of a
 * QA-looking name (e.g. `tsc:watch`). Everything found here is `source: 'auto'`
 * → a SOFT gate (a human-authored `.blastcheck.yml` entry makes a HARD gate).
 *
 * Best-effort and degrading (consistency rule #6): a missing manifest is skipped
 * silently; an unreadable/unparseable one is logged and skipped — autodetect
 * never throws. `package.json` is parsed structurally; `pyproject.toml` and
 * `Makefile` are matched by lightweight text patterns (no TOML dep — the four
 * runtime deps are a hard invariant, NFR7).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../log.js";
import type { RequiredCheck } from "../types.js";

/** QA category of a script/target name, or `null` if it is not a QA signal. */
type QaCategory = "test" | "lint" | "typecheck";

/** Names that are explicitly NOT QA gates (spec §2.5). */
const EXCLUDED = new Set(["build", "dev", "start", "format", "serve", "watch", "clean"]);

/**
 * Classify a script/target name into a QA category. Token-aware so `test:unit`,
 * `lint:fix` and `type-check` are caught; an operational token anywhere in the
 * name (e.g. `tsc:watch`, `lint:dev`) disqualifies it — a long-running watch is
 * not a one-shot QA gate.
 */
function classifyName(name: string): QaCategory | null {
  const tokens = name.toLowerCase().split(/[:-]/);
  if (tokens.some((t) => EXCLUDED.has(t))) return null;
  // The leading token decides the category.
  const head = tokens[0] ?? "";
  if (head === "test" || head === "tests") return "test";
  if (head === "lint" || head === "eslint" || head === "biome") return "lint";
  if (head === "typecheck" || head === "tsc" || (head === "type" && tokens.includes("check"))) {
    return "typecheck";
  }
  return null;
}

/** Read a manifest, or `null` if it is absent/unreadable (degrade, never throw). */
async function readManifest(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      log(
        "warn",
        `autodetect: could not read ${path}: ${err instanceof Error ? err.message : err}`,
      );
    }
    return null;
  }
}

/** `package.json` scripts → `npm` invocations for QA scripts. */
function fromPackageJson(content: string): RequiredCheck[] {
  let scripts: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(content) as { scripts?: Record<string, unknown> };
    scripts = parsed.scripts ?? {};
  } catch (err) {
    log("warn", `autodetect: invalid package.json: ${err instanceof Error ? err.message : err}`);
    return [];
  }
  const checks: RequiredCheck[] = [];
  for (const key of Object.keys(scripts)) {
    if (classifyName(key) === null) continue;
    // `npm test` is the canonical alias; everything else goes through `run`.
    const cmd = key === "test" ? "npm test" : `npm run ${key}`;
    checks.push({ cmd, source: "auto" });
  }
  return checks;
}

/**
 * `pyproject.toml` → the dominant Python QA toolchain, matched by tool table.
 * Only tools that actually configure themselves in `pyproject.toml` are detected
 * (flake8 reads `setup.cfg`/`.flake8`, not `pyproject.toml`, so it is not here).
 */
function fromPyproject(content: string): RequiredCheck[] {
  const checks: RequiredCheck[] = [];
  const has = (re: RegExp) => re.test(content);
  if (has(/\[tool\.pytest/) || has(/\bpytest\b/)) checks.push({ cmd: "pytest", source: "auto" });
  if (has(/\[tool\.ruff/)) checks.push({ cmd: "ruff check", source: "auto" });
  if (has(/\[tool\.mypy/)) checks.push({ cmd: "mypy", source: "auto" });
  return checks;
}

/** `Makefile` → `make <target>` for QA-named targets. */
function fromMakefile(content: string): RequiredCheck[] {
  const checks: RequiredCheck[] = [];
  for (const line of content.split(/\r?\n/)) {
    // A target definition: one or more space-separated names, then `:` (not `:=`).
    // Recipe lines begin with a tab; `:=`/`?=` assignments are excluded via lookahead.
    const m = /^([A-Za-z0-9_.\- ]+?)\s*:(?!=)/.exec(line);
    if (!m) continue;
    // `make all test` declares both `all` and `test` — classify each name.
    for (const target of (m[1] ?? "").split(/\s+/)) {
      if (target === "" || target.startsWith(".")) continue;
      if (classifyName(target) === null) continue;
      checks.push({ cmd: `make ${target}`, source: "auto" });
    }
  }
  return checks;
}

/**
 * Detect autodetected (`source: 'auto'`) required checks across all manifests in
 * `cwd`, deduplicated by `cmd` (first occurrence wins).
 */
export async function detectRequiredChecks(cwd: string): Promise<RequiredCheck[]> {
  const [pkg, pyproject, makefile] = await Promise.all([
    readManifest(join(cwd, "package.json")),
    readManifest(join(cwd, "pyproject.toml")),
    readManifest(join(cwd, "Makefile")),
  ]);

  const found: RequiredCheck[] = [];
  if (pkg) found.push(...fromPackageJson(pkg));
  if (pyproject) found.push(...fromPyproject(pyproject));
  if (makefile) found.push(...fromMakefile(makefile));

  const byCmd = new Map<string, RequiredCheck>();
  for (const rc of found) {
    if (!byCmd.has(rc.cmd)) byCmd.set(rc.cmd, rc);
  }
  return [...byCmd.values()];
}
