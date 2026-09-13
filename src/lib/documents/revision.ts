import { createHash } from "node:crypto";

/** Content-addressed document revision: sha256 of the exact stored bytes. */
export function revisionOf(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
