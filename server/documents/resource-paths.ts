/**
 * Packaged-install resource resolution. The document engines need real files
 * on disk (Liberation fonts, OCR helper binaries); in dev/tests those live
 * under <repo>/resources/documents/, while packaged builds stage them at
 * <standalone>/documents/<subdir> (next to server/cabinet-daemon.cjs and
 * server/document-worker.mjs).
 *
 * Resolution order:
 *   1. CABINET_DOC_RESOURCES_DIR → <env>/<subdir> (Electron spawn env, tests).
 *   2. <entrypoint-dir>/../documents/<subdir> — standalone/Electron layout.
 *   3. <repo>/resources/documents/<subdir> — dev fallback.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function docResourceDir(subdir: string): string {
  const env = process.env.CABINET_DOC_RESOURCES_DIR?.trim();
  if (env) return path.join(env, subdir);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const packaged = path.resolve(here, "..", "documents", subdir);
  if (existsSync(packaged)) return packaged;
  return path.resolve(here, "..", "..", "resources", "documents", subdir);
}
