import type { OcrProvider } from "../../../src/lib/documents/ocr-types";
import { fakeOcrProvider } from "./fake";
import { noneOcrProvider } from "./none";
import { visionMacosProvider } from "./vision-macos";
import { windowsOcrProvider } from "./windows";

/**
 * Provider registry — the seam a future `tesseract` or `lilbee` backend
 * plugs into: register it here, give it an id, and CABINET_OCR_PROVIDER can
 * select it by name.
 */
const PROVIDERS: Record<string, OcrProvider> = {
  "vision-macos": visionMacosProvider,
  windows: windowsOcrProvider,
  none: noneOcrProvider,
  // Test-only fake — selectable via CABINET_OCR_PROVIDER=test-fake so spawned
  // worker processes inherit it through the environment.
  "test-fake": fakeOcrProvider,
};

let overrideForTest: OcrProvider | null = null;

/** Test seam — unit tests inject a fake provider here (never via env). */
export function setOcrProviderForTest(provider: OcrProvider | null): void {
  overrideForTest = provider;
}

export function selectOcrProvider(): OcrProvider {
  if (overrideForTest) return overrideForTest;
  const wanted = process.env.CABINET_OCR_PROVIDER;
  if (wanted) return PROVIDERS[wanted] ?? noneOcrProvider;
  if (process.platform === "darwin") return visionMacosProvider;
  if (process.platform === "win32") return windowsOcrProvider;
  return noneOcrProvider;
}
