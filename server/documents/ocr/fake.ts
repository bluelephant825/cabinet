import type { OcrProvider } from "../../../src/lib/documents/ocr-types";

/**
 * Deterministic fake provider for tests — only reachable via
 * CABINET_OCR_PROVIDER=test-fake (never a platform default), so it can leak
 * into spawned worker processes through the inherited environment.
 *
 *   CABINET_OCR_FAKE_DELAY_MS — delay before responding (cancel tests)
 *   CABINET_OCR_FAKE_HANG=1   — never resolve (timeout tests)
 *   CABINET_OCR_FAKE_EMPTY=1  — resolve null (recognition-failure tests)
 */
export const fakeOcrProvider: OcrProvider = {
  id: "test-fake",
  version: "0",
  capabilities: async () => ({ available: true, languages: ["en-US"] }),
  recognize: async () => {
    if (process.env.CABINET_OCR_FAKE_HANG === "1") {
      return new Promise(() => {});
    }
    const delay = Number(process.env.CABINET_OCR_FAKE_DELAY_MS ?? 0);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    if (process.env.CABINET_OCR_FAKE_EMPTY === "1") return null;
    return {
      lines: [
        {
          text: "Fake OCR recovered line one",
          confidence: 0.9,
          bounds: [0.1, 0.8, 0.9, 0.85],
        },
        {
          text: "Fake OCR recovered line two",
          confidence: 0.85,
          bounds: [0.1, 0.72, 0.9, 0.77],
        },
      ],
      paperShare: 0.95,
      engine: { id: "test-fake", version: "0" },
    };
  },
};
