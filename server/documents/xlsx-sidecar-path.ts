import { accessSync, constants, existsSync } from "node:fs";
import path from "node:path";

import { docResourceDir } from "./resource-paths";

export function xlsxSidecarPath(): string {
  const explicit = process.env.CABINET_XLSX_SIDECAR?.trim();
  if (explicit) return explicit;
  const suffix = process.platform === "win32" ? ".exe" : "";
  const staged = path.join(
    docResourceDir("xlsx"),
    `${process.platform}-${process.arch}`,
    `xlsx-sidecar${suffix}`,
  );
  if (existsSync(staged)) return staged;
  return path.resolve(
    process.cwd(),
    "src/vendor/genoffice/apps/sheets/native/xlsx-engine/target/release",
    `xlsx-sidecar${suffix}`,
  );
}

export function xlsxSidecarAvailable(): boolean {
  try {
    accessSync(
      xlsxSidecarPath(),
      process.platform === "win32" ? constants.F_OK : constants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}
