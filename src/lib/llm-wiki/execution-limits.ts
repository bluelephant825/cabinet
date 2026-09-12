/** Two model stages, each with an initial response and two corrections. */
export const WIKI_INFERENCE_TIMEOUT_MS = 110_000;
export const WIKI_INFERENCE_ATTEMPTS = 3;
export const WIKI_COMPILATION_TIMEOUT_MS = 2 * WIKI_INFERENCE_ATTEMPTS * WIKI_INFERENCE_TIMEOUT_MS + 60_000;
export const WIKI_WORKER_LEASE_MS = 300_000;
export const WIKI_WORKER_HEARTBEAT_MS = 30_000;
