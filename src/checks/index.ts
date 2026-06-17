/**
 * Built-in check registration barrel.
 *
 * The check modules themselves are side-effect-free — each only exports
 * `const check: Check`. Registration happens HERE, explicitly, when this barrel
 * is imported (by `runAudit` wiring and by tests). This keeps the
 * import-for-side-effect out of the individual check files, where import order
 * would be fragile, and gives one obvious place that lists what ships in v1.
 *
 * Story 1.3 registered the three git-only checks; Story 2.2 adds the three
 * trajectory checks. With all six registered, the runner's `requires`-gating
 * marks the trajectory checks `skipped` in a git-only run (no trajectory) and
 * runs them when a trajectory is present (FR16, AR8).
 */

import { check as churn } from "./churn.js";
import { check as deniedFiles } from "./denied-files.js";
import { check as extraneousToolCalls } from "./extraneous-tool-calls.js";
import { check as loopDetection } from "./loop-detection.js";
import { registerCheck } from "./registry.js";
import { check as requiredChecks } from "./required-checks.js";
import { check as scopeAdhesion } from "./scope-adhesion.js";

registerCheck(deniedFiles);
registerCheck(scopeAdhesion);
registerCheck(extraneousToolCalls);
registerCheck(churn);
registerCheck(requiredChecks);
registerCheck(loopDetection);

export { churn, deniedFiles, extraneousToolCalls, loopDetection, requiredChecks, scopeAdhesion };
