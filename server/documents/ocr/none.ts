import type { OcrProvider } from "../../../src/lib/documents/ocr-types";

/** Always-unavailable provider — the registry's last resort. */
export const noneOcrProvider: OcrProvider = {
  id: "none",
  version: "0",
  capabilities: async () => ({
    available: false,
    reason: "No OCR provider on this host",
    languages: [],
  }),
  recognize: async () => null,
};
