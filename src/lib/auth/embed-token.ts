/**
 * Embed token for the P1 host extension's side-panel iframe.
 *
 * The side panel frames the app from a chrome-extension:// top-level site,
 * which makes the iframe cross-site: the SameSite=Lax kb-auth cookie is
 * never sent there. Minting a CHIPS-partitioned cookie (SameSite=None +
 * Secure + Partitioned) gives the panel its own session, but that grant
 * must not be available to arbitrary websites embedding /login — so the
 * login route only honors it when the request carries this per-install
 * token.
 *
 * The token lives in `.cabinet-state/browser-host-extension.json` (random
 * per install, never served by any route). The daemon reads it when it
 * generates the extension and bakes it into sidepanel.html; the login
 * route reads it to verify ?embedToken= requests. Both processes resolve
 * the same path via getManagedDataParentDir().
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { getManagedDataParentDir } from "@/lib/runtime/runtime-config";

function tokenFilePath(): string {
  return path.join(
    getManagedDataParentDir(),
    ".cabinet-state",
    "browser-host-extension.json",
  );
}

function readState(): { embedToken?: string } {
  try {
    const parsed = JSON.parse(fs.readFileSync(tokenFilePath(), "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** The current token, or null when the host extension has never been
 *  generated. Returns null for missing/malformed state. */
export function getHostExtensionEmbedToken(): string | null {
  const token = readState().embedToken;
  return typeof token === "string" && /^[0-9a-f]{64}$/.test(token)
    ? token
    : null;
}

/** Read the token, creating and persisting a fresh random one if absent.
 *  Called by the daemon when it generates the extension files. */
export function ensureHostExtensionEmbedToken(): string {
  const existing = getHostExtensionEmbedToken();
  if (existing) return existing;
  const token = crypto.randomBytes(32).toString("hex");
  const file = tokenFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify({ ...readState(), embedToken: token }, null, 2),
    "utf-8",
  );
  fs.renameSync(tmp, file);
  return token;
}
