/**
 * The default reporter: the pre-surfacing behavior, preserved verbatim.
 *
 * Writes the scorecard JSON to stdout and the human summary to stderr, and maps
 * the verdict to the exit code (`fail` → 1, else 0). This is what `runStop` did
 * before the reporter layer existed, so the generic `runStop(payload, cwd)` — and
 * every test that calls it directly — behaves exactly as before. The per-agent
 * reporters (Claude Code, Codex, OpenCode) are wired in only at the CLI layer.
 */

import { printScorecard } from "../scorecard/print.js";
import { EXIT } from "../types.js";
import type { ReportContext, Reporter, SurfacingOptions } from "./types.js";

export const rawReporter: Reporter = {
  surface({ scorecard, json }: ReportContext, _options: SurfacingOptions) {
    // stdout: the machine contract, and nothing else (NFR9).
    process.stdout.write(json);
    // stderr: the human-readable summary.
    printScorecard(scorecard);
    return scorecard.verdict === "fail" ? EXIT.FAIL : EXIT.OK;
  },
};
