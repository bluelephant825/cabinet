import { accessSync, constants, existsSync } from "node:fs";
import path from "node:path";
import type { OcrProvider } from "../../../src/lib/documents/ocr-types";
import { HELPER_DEFAULT_TIMEOUT_MS, runOcrHelper } from "./helper";
import { docResourceDir } from "../resource-paths";

/**
 * macOS Vision OCR provider — wraps the compiled `vision-ocr` helper (Swift
 * source vendored in src/vendor/genoffice/packages/pdf2docx/ocr-helper/,
 * built by `npm run ocr:build` into resources/documents/ocr/darwin-<arch>/).
 */

/** Languages Vision commonly recognizes; passed as hints when the user picks. */
const VISION_LANGUAGES = [
  "en-US",
  "en-GB",
  "zh-Hans",
  "zh-Hant",
  "fr-FR",
  "de-DE",
  "es-ES",
  "it-IT",
  "pt-BR",
  "ja-JP",
  "ko-KR",
  "ru-RU",
  "nl-NL",
  "sv-SE",
  "he-IL",
  "ar-SA",
];

export function visionHelperPath(): string {
  const dir =
    process.env.CABINET_OCR_HELPER_DIR ??
    path.join(docResourceDir("ocr"), `darwin-${process.arch}`);
  return path.join(dir, "vision-ocr");
}

function executable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export const visionMacosProvider: OcrProvider = {
  id: "vision-macos",
  version: "1",
  capabilities: async () => {
    if (process.platform !== "darwin") {
      return { available: false, reason: "Apple Vision OCR requires macOS", languages: [] };
    }
    const helper = visionHelperPath();
    if (!existsSync(helper) || !executable(helper)) {
      return {
        available: false,
        reason: "Vision OCR helper not built (run npm run ocr:build)",
        languages: VISION_LANGUAGES,
      };
    }
    return { available: true, languages: VISION_LANGUAGES };
  },
  recognize: async ({ imagePath, languageHints, timeoutMs }) =>
    runOcrHelper({
      helperPath: visionHelperPath(),
      imagePath,
      languages: languageHints,
      timeoutMs: timeoutMs || HELPER_DEFAULT_TIMEOUT_MS,
      engine: { id: "vision-macos", version: "1" },
    }),
};
