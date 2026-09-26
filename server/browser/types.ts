/**
 * Shared types for the Cabinet Browser daemon module: a Chromium sidecar
 * (Chrome for Testing) driven over CDP via --remote-debugging-pipe.
 */

export type BrowserStatus =
  | "missing"
  | "downloading"
  | "stopped"
  | "starting"
  | "running"
  | "error";

export type BrowserTab = {
  id: string;
  targetId: string;
  url: string;
  title: string;
  active: boolean;
};

export type BrowserExtensionRecord = {
  id: string;
  name: string;
  version: string;
  path: string;
  description: string;
  iconDataUrl: string | null;
  popupHtml: string | null;
  optionsPage: string | null;
  contentScriptMatches: string[];
  enabled: boolean;
  pinned: boolean;
  runtimeId: string | null;
  /** True for user-selected "load unpacked" directories: `path` is the
   *  user's source folder, so uninstall drops the record without deleting
   *  files. Absent/undefined on Web Store records (managed copies). */
  unpacked?: boolean;
};

export type BrowserErrorCode =
  | "unavailable"
  | "not-found"
  | "invalid"
  | "download-failed"
  | "launch-failed"
  | "cdp"
  | "unauthorized";

const HTTP_STATUS: Record<BrowserErrorCode, number> = {
  unavailable: 503,
  "not-found": 404,
  invalid: 400,
  "download-failed": 502,
  "launch-failed": 502,
  cdp: 502,
  unauthorized: 401,
};

/**
 * Browser-module error with a wire-safe code. `message` must never contain
 * absolute filesystem paths — callers forward it to HTTP clients.
 */
export class BrowserError extends Error {
  readonly code: BrowserErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: BrowserErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "BrowserError";
    this.code = code;
    this.details = details;
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }
}

export function asBrowserError(err: unknown, fallbackCode: BrowserErrorCode = "cdp"): BrowserError {
  if (err instanceof BrowserError) return err;
  return new BrowserError(fallbackCode, err instanceof Error ? err.message : String(err));
}
