export type DocumentErrorCode =
  | "not-found"
  | "unauthorized"
  | "read-only"
  | "conflict"
  | "unsupported"
  | "invalid"
  | "too-large"
  | "storage"
  | "busy"
  | "cancelled"
  | "worker-failed"
  | "verification-failed"
  | "degraded";

const HTTP_STATUS: Record<DocumentErrorCode, number> = {
  "not-found": 404,
  unauthorized: 401,
  "read-only": 403,
  conflict: 409,
  unsupported: 400,
  invalid: 422,
  "too-large": 413,
  storage: 402,
  busy: 429,
  cancelled: 409,
  "worker-failed": 500,
  "verification-failed": 500,
  degraded: 422,
};

/**
 * Document-service error with a wire-safe code. `message` must never contain
 * absolute filesystem paths — callers forward it to HTTP clients.
 */
export class DocumentError extends Error {
  readonly code: DocumentErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: DocumentErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "DocumentError";
    this.code = code;
    this.details = details;
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }
}

export function asDocumentError(err: unknown, fallbackCode: DocumentErrorCode = "invalid"): DocumentError {
  if (err instanceof DocumentError) return err;
  return new DocumentError(fallbackCode, err instanceof Error ? err.message : String(err));
}
