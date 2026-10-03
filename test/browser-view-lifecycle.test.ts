import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync(new URL("../src/components/layout/browser-view.tsx", import.meta.url), "utf8");
const sourceFile = ts.createSourceFile("browser-view.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let effectSource = "";

function findEffect(node: ts.Node): void {
  if (ts.isCallExpression(node) && node.expression.getText(sourceFile) === "useEffect") {
    const callback = node.arguments[0];
    if (callback?.getText(sourceFile).includes("const attemptInit =")) {
      effectSource = callback.getText(sourceFile);
    }
  }
  ts.forEachChild(node, findEffect);
}

findEffect(sourceFile);
assert.ok(effectSource, "native browser-view initialization effect exists");
const effectScript = ts.transpileModule(`(${effectSource})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

type CreationResult = { ok: boolean; viewId?: string };

function createHarness() {
  const pending: Array<(result: CreationResult) => void> = [];
  const destroyed: string[] = [];
  const loads: Array<{ viewId: string; url: string }> = [];
  const modes: string[] = [];
  const viewIdRef = { current: null as string | null };
  let boundsUpdates = 0;
  const bridge = {
    createBrowserView: () => new Promise<CreationResult>((resolve) => pending.push(resolve)),
    destroyBrowserView: async (viewId: string) => {
      destroyed.push(viewId);
      return { ok: true };
    },
    setBrowserViewVisible: async () => ({ ok: true }),
    loadBrowserViewUrl: async (viewId: string, url: string) => {
      loads.push({ viewId, url });
      return { ok: true };
    },
  };
  const effect = vm.runInNewContext(effectScript, {
    window: { clearTimeout, setTimeout },
    sidecarParkTimerRef: { current: null },
    sidecarStatusRef: { current: null },
    getHost: () => ({ kind: "electron", electron: bridge }),
    useAppStore: { getState: () => ({ browseUrl: "/media-player?type=audio" }) },
    isSidecarUrl: () => false,
    setBrowserMode: (mode: string) => modes.push(mode),
    setElectronFailure: () => {},
    viewIdRef,
    updateBoundsRef: { current: () => { boundsUpdates += 1; } },
  }) as () => () => void;
  return { effect, pending, destroyed, loads, modes, viewIdRef, boundsUpdates: () => boundsUpdates };
}

async function flush() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("native view created after unmount is destroyed without being activated", async () => {
  const harness = createHarness();
  const cleanup = harness.effect();
  cleanup();
  harness.pending[0]({ ok: true, viewId: "abandoned" });
  await flush();

  assert.deepEqual(harness.destroyed, ["abandoned"]);
  assert.equal(harness.viewIdRef.current, null);
  assert.deepEqual(harness.loads, []);
  assert.deepEqual(harness.modes, ["initializing"]);
  assert.equal(harness.boundsUpdates(), 0);
});

test("late creation from a cancelled effect does not replace the remounted view", async () => {
  const harness = createHarness();
  harness.effect()();
  const cleanup = harness.effect();
  harness.pending[1]({ ok: true, viewId: "active" });
  await flush();
  harness.pending[0]({ ok: true, viewId: "abandoned" });
  await flush();

  assert.deepEqual(harness.destroyed, ["abandoned"]);
  assert.equal(harness.viewIdRef.current, "active");
  assert.deepEqual(harness.loads, [{ viewId: "active", url: "/media-player?type=audio" }]);
  assert.equal(harness.boundsUpdates(), 1);

  cleanup();
  assert.deepEqual(harness.destroyed, ["abandoned", "active"]);
  assert.equal(harness.viewIdRef.current, null);
});

test("active native view is loaded and destroyed by normal cleanup", async () => {
  const harness = createHarness();
  const cleanup = harness.effect();
  harness.pending[0]({ ok: true, viewId: "active" });
  await flush();

  assert.equal(harness.viewIdRef.current, "active");
  assert.deepEqual(harness.modes, ["initializing", "electron"]);
  assert.deepEqual(harness.destroyed, []);
  cleanup();
  assert.deepEqual(harness.destroyed, ["active"]);
  assert.equal(harness.viewIdRef.current, null);
});

test("cancelled failed creation without a view ID requires no destruction", async () => {
  const harness = createHarness();
  harness.effect()();
  harness.pending[0]({ ok: false });
  await flush();

  assert.deepEqual(harness.destroyed, []);
  assert.deepEqual(harness.modes, ["initializing"]);
});
