import { existsSync } from "node:fs";
import path from "node:path";
import type { OcrProvider } from "../../../src/lib/documents/ocr-types";
import { HELPER_DEFAULT_TIMEOUT_MS, runOcrHelper } from "./helper";
import { docResourceDir } from "../resource-paths";

/**
 * Windows.Media.Ocr provider — wraps win-ocr.exe (C# source vendored in
 * src/vendor/genoffice/packages/pdf2docx/ocr-helper/, built by
 * `npm run ocr:build` into resources/documents/ocr/win32-x64/). Contract only
 * on this host — the binary cannot be built or signed on macOS.
 */
const WIN_LANGUAGES = ["en-US", "zh-Hans-CN", "fr-FR", "de-DE", "es-ES", "ja-JP", "ko-KR"];

export function windowsHelperPath(): string {
  const dir =
    process.env.CABINET_OCR_HELPER_DIR ??
    path.join(docResourceDir("ocr"), "win32-x64");
  return path.join(dir, "win-ocr.exe");
}

export const windowsOcrProvider: OcrProvider = {
  id: "windows",
  version: "1",
  capabilities: async () => {
    if (process.platform !== "win32") {
      return { available: false, reason: "Windows OCR requires Windows", languages: [] };
    }
    if (!existsSync(windowsHelperPath())) {
      return {
        available: false,
        reason: "Windows OCR helper not built (run npm run ocr:build)",
        languages: WIN_LANGUAGES,
      };
    }
    return { available: true, languages: WIN_LANGUAGES };
  },
  recognize: async ({ imagePath, languageHints, timeoutMs }) =>
    runOcrHelper({
      helperPath: windowsHelperPath(),
      imagePath,
      languages: languageHints,
      timeoutMs: timeoutMs || HELPER_DEFAULT_TIMEOUT_MS,
      engine: { id: "windows", version: "1" },
    }),
};
