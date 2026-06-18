/**
 * Pure conversion helper behind `blastcheck adapt` (AC6).
 *
 * Runs the registry adapter for `format` over the raw native log and serializes
 * the resulting events as common trajectory JSONL (one `snake_case` event per
 * line). Kept free of CLI/IO concerns so it is unit-testable without spawning a
 * process; the CLI layer owns reading the file, writing stdout, and exit codes.
 */

import { getAdapter, type TrajectoryFormat } from "./index.js";

export function adaptLogToJsonl(format: TrajectoryFormat, rawText: string): string {
  return getAdapter(format)(rawText)
    .map((event) => `${JSON.stringify(event)}\n`)
    .join("");
}
