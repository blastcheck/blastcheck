/**
 * The reporter (egress) layer — public barrel. The core computes one scorecard;
 * a per-agent reporter surfaces it in that agent's native idiom (brief §8).
 */

export { claudeCodeReporter } from "./claude-code.js";
export { codexReporter } from "./codex.js";
export { opencodeReporter } from "./opencode.js";
export { resolveSurfacingOptions } from "./options.js";
export { rawReporter } from "./raw.js";
export { DEFAULT_SURFACING, type Reporter, type SurfacingOptions } from "./types.js";
export { verdictDetail, verdictHeadline } from "./verdict-text.js";
