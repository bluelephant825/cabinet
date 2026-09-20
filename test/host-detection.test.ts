import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { detectHostKind } from "@/lib/host";

// detectHostKind reads globals through `(globalThis as { window?: ... }).window`
// so tests inject a stub `window` per case and restore the original after.
const originalWindow = (globalThis as { window?: unknown }).window;

afterEach(() => {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
});

const cases: Array<{ name: string; window: unknown; expected: string }> = [
  {
    name: "chromium when window.cabinetHost exists",
    window: { cabinetHost: { platform: "darwin" } },
    expected: "chromium",
  },
  {
    name: "electron when CabinetDesktop.runtime is electron",
    window: { CabinetDesktop: { runtime: "electron", platform: "darwin" } },
    expected: "electron",
  },
  {
    name: "web when neither global exists",
    window: {},
    expected: "web",
  },
  {
    name: "web when CabinetDesktop lacks the electron runtime marker",
    window: { CabinetDesktop: { platform: "darwin" } },
    expected: "web",
  },
  {
    name: "cabinetHost takes precedence over CabinetDesktop",
    window: {
      cabinetHost: {},
      CabinetDesktop: { runtime: "electron" },
    },
    expected: "chromium",
  },
];

for (const { name, window: stub, expected } of cases) {
  test(name, () => {
    (globalThis as { window?: unknown }).window = stub;
    assert.equal(detectHostKind(), expected);
  });
}

test("web when the window global is absent entirely", () => {
  delete (globalThis as { window?: unknown }).window;
  assert.equal(detectHostKind(), "web");
});
