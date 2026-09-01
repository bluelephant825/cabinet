/**
 * Shared, isomorphic definitions for a server whose configured data directory
 * changed after boot. Keep this module free of Node and Next.js imports so the
 * server response helpers and browser recovery code can share the protocol.
 */

export const STALE_PROCESS_CODE = "STALE_PROCESS";
export const STALE_PROCESS_HEADER = "x-cabinet-stale";
export const STALE_PROCESS_MESSAGE =
  "Cabinet server process is stale (the configured data directory changed on disk). Please restart the process to apply the change.";

export class StaleProcessError extends Error {
  readonly code = STALE_PROCESS_CODE;

  constructor(message: string = STALE_PROCESS_MESSAGE) {
    super(message);
    this.name = "StaleProcessError";
  }
}

export function isStaleProcessError(error: unknown): error is Error {
  return (
    error instanceof StaleProcessError ||
    (error instanceof Error &&
      error.message.includes("configured data directory changed on disk"))
  );
}

export function isStaleProcessResponse(response: Response): boolean {
  return (
    response.status === 503 && response.headers.has(STALE_PROCESS_HEADER)
  );
}
