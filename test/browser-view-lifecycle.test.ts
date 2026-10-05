import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { useAppStore } from "../src/stores/app-store";

const source = fs.readFileSync(new URL("../src/components/layout/browser-view.tsx", import.meta.url), "utf8");
const sourceFile = ts.createSourceFile("browser-view.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let effectSource = "";
let backSource = "";
let syncSource = "";
let navigationSource = "";
let loadTabsSource = "";
let refreshTabsSource = "";

function findEffect(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(sourceFile) === "useCallback") {
    if (node.name.getText(sourceFile) === "loadSidecarTabs") loadTabsSource = node.initializer.arguments[0].getText(sourceFile);
    if (node.name.getText(sourceFile) === "refreshSidecarTabs") refreshTabsSource = node.initializer.arguments[0].getText(sourceFile);
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(sourceFile) === "syncActiveSidecarTab" && node.initializer) syncSource = node.initializer.getText(sourceFile);
  if (ts.isVariableDeclaration(node) && node.name.getText(sourceFile) === "navigateBack" && node.initializer) backSource = node.initializer.getText(sourceFile);
  if (ts.isCallExpression(node) && node.expression.getText(sourceFile) === "useEffect") {
    const callback = node.arguments[0];
    if (callback?.getText(sourceFile).includes("const request = navigationRequest;")) navigationSource = callback.getText(sourceFile);
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
assert.ok(backSource, "browser Back handler exists");
const backScript = ts.transpileModule(`(${backSource})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

assert.ok(syncSource, "active browser tab synchronization exists");
const syncScript = ts.transpileModule(`(${syncSource})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

for (const callback of [navigationSource, loadTabsSource, refreshTabsSource]) assert.ok(callback, "sidecar navigation and tab-refresh callbacks exist");
const [navigationScript, loadTabsScript, refreshTabsScript] = [navigationSource, loadTabsSource, refreshTabsSource].map((callback) => ts.transpileModule(`(${callback})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText);

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

test("browse intent versions protect newer navigation and distinguish session restoration", () => {
  const original = useAppStore.getState();
  try {
    original.setAppMode("browse", "https://offrun.dev/");
    const first = useAppStore.getState().browseNavigationRequest!;
    original.syncBrowseUrl("https://www.wikiwand.com/extension-installed");
    assert.equal(useAppStore.getState().browseUrl, first.url);
    original.setAppMode("browse", "https://example.com/newer");
    const newer = useAppStore.getState().browseNavigationRequest!;
    assert.ok(newer.version > first.version);
    original.completeBrowseNavigation(first.version);
    assert.equal(useAppStore.getState().browseNavigationRequest, newer);
    original.completeBrowseNavigation(newer.version);
    original.syncBrowseUrl("https://www.wikiwand.com/extension-installed");
    original.setAppMode("edit");
    original.setAppMode("browse");
    assert.equal(useAppStore.getState().browseNavigationRequest, null);
    assert.equal(useAppStore.getState().browseUrl, "https://www.wikiwand.com/extension-installed");
    original.setAppMode("browse", "https://offrun.dev/");
    original.setAppMode("edit");
    assert.equal(useAppStore.getState().browseNavigationRequest, null);
  } finally {
    useAppStore.setState(original, true);
  }
});

test("an existing active-tab echo cannot replace a pending explicit RSS URL", () => {
  let browseUrl = "https://offrun.dev/";
  const sync = vm.runInNewContext(syncScript, {
    activeEngineRef: { current: "sidecar" },
    normalizeSessionUrl: (url: string) => url,
    recordNavigation: () => {},
    useAppStore: { getState: () => ({ browseUrl, browseNavigationRequest: { version: 1, url: browseUrl } }) },
    suppressNextSidecarLoadRef: { current: false },
    isSidecarUrl: () => true,
    setAppMode: (_mode: string, url: string) => { browseUrl = url; },
    syncBrowseUrl: (url: string) => { browseUrl = url; },
  }) as (url: string) => void;
  sync("https://www.wikiwand.com/extension-installed");
  assert.equal(browseUrl, "https://offrun.dev/");
});

test("navigation completion refreshes metadata even when the title event arrived while pending", async () => {
  const request = { version: 1, url: "https://offrun.dev/" };
  let pending: typeof request | null = request;
  const tab = { id: "existing", targetId: "existing", url: "https://www.wikiwand.com/extension-installed", title: "Wikiwand", active: true };
  const sidecarTabsRef = { current: [tab] };
  let displayed = [tab], refreshes = 0;
  const effect = vm.runInNewContext(navigationScript, {
    activeEngine: "sidecar", navigationRequest: request,
    restoreSidecarSessionRef: { current: false }, sidecarNavigationRef: { current: null },
    sidecarStatusRef: { current: { status: "running" } }, sidecarTabsLoadedRef: { current: true },
    sidecarTabsRef, pendingSidecarOpenRef: { current: null },
    useAppStore: { getState: () => ({ browseNavigationRequest: pending }) },
    loadSidecarTabs: async () => sidecarTabsRef.current,
    navigateSidecarTab: async () => ({ tab: { ...tab, url: request.url } }),
    setSidecarTabs: (tabs: typeof displayed) => { displayed = tabs; },
    completeBrowseNavigation: () => { pending = null; }, syncBrowseUrl: () => {},
    refreshSidecarTabs: () => { assert.equal(pending, null); refreshes++; displayed = [{ ...tab, url: request.url, title: "Offrun" }]; },
    setSidecarFailedUrl: () => assert.fail("navigation should succeed"),
  }) as () => () => void;
  const cleanup = effect();
  await flush();
  assert.equal(refreshes, 1);
  assert.equal(displayed[0].title, "Offrun");
  cleanup();
});

test("tab events received during hydration trigger a fresh follow-up instead of losing the latest title", async () => {
  const tab = { id: "existing", targetId: "existing", url: "https://offrun.dev/", title: "Wikiwand", active: true };
  let displayed = [tab];
  const resolves: Array<(tabs: typeof displayed) => void> = [];
  const context = {
    sidecarStatusRef: { current: { status: "running" } },
    sidecarTabLoadRef: { current: null }, sidecarTabsDirtyRef: { current: false },
    sidecarTabsRef: { current: [] as typeof displayed }, sidecarTabsLoadedRef: { current: false },
    useAppStore: { getState: () => ({ browseNavigationRequest: null }) },
    listSidecarTabs: () => new Promise<typeof displayed>((resolve) => resolves.push(resolve)),
    setSidecarTabs: (tabs: typeof displayed) => { displayed = tabs; },
    syncActiveSidecarTabRef: { current: () => {} },
    loadSidecarTabs: async () => [] as typeof displayed,
  };
  context.loadSidecarTabs = vm.runInNewContext(loadTabsScript, context) as typeof context.loadSidecarTabs;
  const refresh = vm.runInNewContext(refreshTabsScript, context) as () => void;
  refresh(); refresh();
  assert.equal(resolves.length, 1);
  resolves[0]([tab]);
  await flush();
  assert.equal(resolves.length, 2);
  resolves[1]([{ ...tab, title: "Offrun" }]);
  await flush();
  assert.equal(displayed[0].title, "Offrun");
  assert.equal(resolves.length, 2);
});

test("a tab snapshot fetched before a newer navigation is discarded and rehydrated", async () => {
  const oldTab = { id: "existing", targetId: "existing", url: "https://www.wikiwand.com/extension-installed", title: "Wikiwand", active: true };
  const currentTab = { ...oldTab, url: "https://offrun.dev/", title: "Offrun" };
  let version = 1;
  let displayed: typeof oldTab[] = [];
  const resolves: Array<(tabs: typeof displayed) => void> = [];
  const context = {
    sidecarTabLoadRef: { current: null }, sidecarTabsDirtyRef: { current: false },
    sidecarTabsRef: { current: [] as typeof displayed }, sidecarTabsLoadedRef: { current: false },
    useAppStore: { getState: () => ({ browseNavigationVersion: version }) },
    listSidecarTabs: () => new Promise<typeof displayed>((resolve) => resolves.push(resolve)),
    setSidecarTabs: (tabs: typeof displayed) => { displayed = tabs; },
  };
  const load = vm.runInNewContext(loadTabsScript, context) as () => Promise<typeof displayed>;
  const pending = load();
  version++;
  resolves[0]([oldTab]);
  await flush();
  assert.equal(displayed.length, 0);
  assert.equal(resolves.length, 2);
  resolves[1]([currentTab]);
  assert.equal((await pending)[0].url, currentTab.url);
  assert.equal(displayed[0].title, "Offrun");
});

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

test("browser Back from RSS restores the reader without going back in an existing web tab", () => {
  let returned = 0, browserBacks = 0;
  const back = vm.runInNewContext(backScript, {
    onReturnToSource: () => { returned++; },
    activeEngine: "sidecar",
    sidecarTabsRef: { current: [{ id: "existing", active: true }] },
    backSidecarTab: () => { browserBacks++; return Promise.resolve({ ok: true }); },
    iframeNavActionRef: { current: null },
  }) as () => void;
  back();
  assert.equal(returned, 1);
  assert.equal(browserBacks, 0);
});

test("browser Back without an RSS source still uses the web page's history", () => {
  let browserBacks = 0;
  const back = vm.runInNewContext(backScript, {
    onReturnToSource: undefined,
    activeEngine: "native",
    browserMode: "iframe",
    iframeRef: { current: { contentWindow: { history: { back: () => { browserBacks++; } } } } },
  }) as () => void;
  back();
  assert.equal(browserBacks, 1);
});
