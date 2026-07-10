/**
 * Programmatic surface of the Bahama CLI. The supported interface is the
 * `bahama` binary and its JSON envelopes; these exports exist for the CLI's
 * own tests and for embedding in the monorepo.
 */
export { buildRegistry, buildEngine, envelope, exitCodeFor } from "./runtime.js";
export { renderHuman } from "./render.js";
export { compileAndDescribe } from "./plan-shared.js";
