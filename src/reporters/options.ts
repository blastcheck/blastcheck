/**
 * Resolve the opt-in {@link SurfacingOptions} for a repo (brief §7.2 / §7.3).
 *
 * Two sources, both optional, env wins so a one-off run can override config:
 *  1. `.blastcheck.yml` `surfacing: { feedback, block }` — the persistent project
 *     choice. Read leniently (the surfacing block is orthogonal to the scope
 *     contract; an unknown/absent block degrades to defaults, never throws).
 *  2. `BLASTCHECK_FEEDBACK` / `BLASTCHECK_BLOCK` env vars — a per-invocation
 *     override (`1`/`true`/`yes`/`on` → true, `0`/`false`/`no`/`off` → false).
 *
 * Default is the passive posture {@link DEFAULT_SURFACING}: both OFF.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { surfacingSchema } from "../contract/schema.js";
import { log } from "../log.js";
import { DEFAULT_SURFACING, type SurfacingOptions } from "./types.js";

/** Parse a boolean-ish env var; `undefined` when unset or unrecognized. */
function envFlag(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  log("warn", `surfacing: ignoring unrecognized ${name}="${raw}" (use 1/0)`);
  return undefined;
}

/** Read the `.blastcheck.yml` `surfacing:` block; absent/invalid → no opinion. */
async function readYmlSurfacing(cwd: string): Promise<{ feedback?: boolean; block?: boolean }> {
  let content: string;
  try {
    content = await readFile(join(cwd, ".blastcheck.yml"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      log(
        "warn",
        `surfacing: could not read .blastcheck.yml: ${err instanceof Error ? err.message : err}`,
      );
    }
    return {};
  }

  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch {
    // A malformed file is already warned about by the contract resolver; stay quiet.
    return {};
  }

  const parsed = surfacingSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

export async function resolveSurfacingOptions(cwd: string): Promise<SurfacingOptions> {
  const yml = await readYmlSurfacing(cwd);
  return {
    feedback: envFlag("BLASTCHECK_FEEDBACK") ?? yml.feedback ?? DEFAULT_SURFACING.feedback,
    block: envFlag("BLASTCHECK_BLOCK") ?? yml.block ?? DEFAULT_SURFACING.block,
  };
}
