/**
 * BrowserSession wraps a CDPClient with a tab model and page-level ops.
 *
 * Targets: we track `page` targets only. chrome:// internal targets are
 * skipped from the tab list except top-level `chrome-extension://` pages
 * (extension options pages are legit tabs). Tab id = CDP targetId.
 *
 * Page ops need a session: we lazily `Target.attachToTarget({flatten:true})`
 * per page target and cache sessionIds; entries drop on
 * Target.detachedFromTarget / targetDestroyed.
 *
 * Web Store install: every page gets Page.addScriptToEvaluateOnNewDocument with
 * WEBSTORE_HOOK_SCRIPT plus a Runtime.addBinding("cabinetInstallExtension").
 * Runtime.bindingCalled events are routed to `onInstallExtension`.
 */
import { EventEmitter } from "node:events";
import fsp from "node:fs/promises";
import { dirname } from "node:path";
import type { CDPClient } from "./cdp-client";
import { BrowserError, type BrowserTab } from "./types";
import { browserStatePath } from "./paths";
import { WEBSTORE_HOOK_SCRIPT } from "./webstore-hook";

const EXTRACT_TEXT_CAP = 500 * 1024;

export type BrowserSessionOptions = {
  /** Called when the web-store hook binding fires; returns a status label. */
  onInstallExtension?: (extensionId: string, sessionId: string) => Promise<void>;
};

type TargetInfo = {
  targetId: string;
  type: string;
  url: string;
  title: string;
  attached?: boolean;
};

type WindowBounds = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  visible?: boolean;
};

function isInternalTarget(info: TargetInfo): boolean {
  if (info.type !== "page") return true;
  const url = info.url || "";
  if (url.startsWith("chrome-extension://")) return false; // options pages are real tabs
  if (url.startsWith("chrome://") || url.startsWith("devtools://")) return true;
  return false;
}

export class BrowserSession extends EventEmitter {
  private readonly targets = new Map<string, TargetInfo>();
  private readonly sessions = new Map<string, string>(); // targetId -> sessionId
  private activeTargetId: string | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(
    private readonly cdp: CDPClient,
    private readonly options: BrowserSessionOptions = {},
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.cdp.onEvent("Target.targetCreated", (event) => {
      const info = event.params?.targetInfo as TargetInfo | undefined;
      if (!info || info.type !== "page") return;
      this.targets.set(info.targetId, { ...info });
      this.emitTab("tab-created", info.targetId);
    });
    this.cdp.onEvent("Target.targetInfoChanged", (event) => {
      const info = event.params?.targetInfo as TargetInfo | undefined;
      if (!info || info.type !== "page") return;
      this.targets.set(info.targetId, { ...(this.targets.get(info.targetId) ?? info), ...info });
      this.emitTab("tab-updated", info.targetId);
    });
    this.cdp.onEvent("Target.targetDestroyed", (event) => {
      const targetId = event.params?.targetId as string | undefined;
      if (!targetId) return;
      const tab = this.toTab(this.targets.get(targetId));
      this.targets.delete(targetId);
      this.sessions.delete(targetId);
      if (this.activeTargetId === targetId) this.activeTargetId = null;
      if (tab) this.emit("tab-closed", tab);
      this.schedulePersist();
    });
    this.cdp.onEvent("Target.attachedToTarget", (event) => {
      const sessionId = event.params?.sessionId as string | undefined;
      const info = event.params?.targetInfo as TargetInfo | undefined;
      if (!sessionId || !info || info.type !== "page") return;
      this.sessions.set(info.targetId, sessionId);
      void this.preparePageSession(sessionId).catch(() => {});
    });
    this.cdp.onEvent("Target.detachedFromTarget", (event) => {
      const sessionId = event.params?.sessionId as string | undefined;
      if (!sessionId) return;
      for (const [targetId, sid] of this.sessions) {
        if (sid === sessionId) this.sessions.delete(targetId);
      }
    });
    this.cdp.onEvent("Page.frameNavigated", (event) => {
      // Target.targetInfoChanged lags behind the actual navigation; update the
      // tracked URL as soon as the top frame commits.
      const sessionId = event.sessionId;
      const frame = event.params?.frame as { parentId?: string; url?: string } | undefined;
      if (!sessionId || !frame || frame.parentId || typeof frame.url !== "string") return;
      let targetId: string | null = null;
      for (const [tid, sid] of this.sessions) {
        if (sid === sessionId) {
          targetId = tid;
          break;
        }
      }
      if (!targetId) return;
      const info = this.targets.get(targetId);
      if (!info || info.url === frame.url) return;
      info.url = frame.url;
      this.emitTab("tab-updated", targetId);
    });
    this.cdp.onEvent("Runtime.bindingCalled", (event) => {
      if (event.params?.name !== "cabinetInstallExtension") return;
      const sessionId = event.sessionId;
      if (!sessionId) return;
      let extensionId: string | null = null;
      try {
        const payload = JSON.parse(String(event.params?.payload ?? "{}")) as { id?: unknown };
        if (typeof payload.id === "string" && /^[a-p]{32}$/.test(payload.id)) {
          extensionId = payload.id;
        }
      } catch {}
      if (extensionId && this.options.onInstallExtension) {
        void this.options.onInstallExtension(extensionId, sessionId).catch(() => {});
      }
    });

    await this.cdp.send("Target.setDiscoverTargets", { discover: true });
    await this.cdp.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
  }

  private emitTab(kind: "tab-created" | "tab-updated", targetId: string): void {
    const tab = this.toTab(this.targets.get(targetId));
    if (tab) this.emit(kind, tab);
    this.schedulePersist();
  }

  private toTab(info: TargetInfo | undefined): BrowserTab | null {
    if (!info || isInternalTarget(info)) return null;
    return {
      id: info.targetId,
      targetId: info.targetId,
      url: info.url || "about:blank",
      title: info.title || "",
      active: info.targetId === this.activeTargetId,
    };
  }

  private async sessionFor(targetId: string): Promise<string> {
    const cached = this.sessions.get(targetId);
    if (cached) return cached;
    const result = (await this.cdp.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    })) as { sessionId?: string } | undefined;
    const sessionId = result?.sessionId;
    if (!sessionId) {
      throw new BrowserError("cdp", `Could not attach to target ${targetId}`);
    }
    this.sessions.set(targetId, sessionId);
    void this.preparePageSession(sessionId).catch(() => {});
    return sessionId;
  }

  private async preparePageSession(sessionId: string): Promise<void> {
    await this.cdp.send("Page.enable", {}, sessionId).catch(() => {});
    await this.cdp
      .send(
        "Page.addScriptToEvaluateOnNewDocument",
        { source: WEBSTORE_HOOK_SCRIPT },
        sessionId,
      )
      .catch(() => {});
    await this.cdp
      .send("Runtime.addBinding", { name: "cabinetInstallExtension" }, sessionId)
      .catch(() => {});
  }

  private requireTarget(id: string): TargetInfo {
    const info = this.targets.get(id);
    if (!info || isInternalTarget(info)) {
      throw new BrowserError("not-found", "Tab not found");
    }
    return info;
  }

  listTabs(): BrowserTab[] {
    const tabs: BrowserTab[] = [];
    for (const info of this.targets.values()) {
      const tab = this.toTab(info);
      if (tab) tabs.push(tab);
    }
    return tabs;
  }

  /**
   * Chrome's own tab strip changes the active tab without any Target event we
   * can rely on, so the tracked activeTargetId goes stale. The ground truth is
   * each page's document.visibilityState: exactly one page target is "visible"
   * (the frontmost tab of a non-minimized window). If several report visible
   * (multi-window) we keep the current active when it is among them.
   */
  async refreshActiveTab(): Promise<void> {
    const checks = [...this.targets.values()]
      .filter((info) => !isInternalTarget(info))
      .map(async (info) => {
        try {
          const sessionId = await this.sessionFor(info.targetId);
          const result = (await this.cdp.send(
            "Runtime.evaluate",
            { expression: "document.visibilityState", returnByValue: true },
            sessionId,
          )) as { result?: { value?: unknown } } | undefined;
          return result?.result?.value === "visible" ? info.targetId : null;
        } catch {
          return null;
        }
      });
    const visible = (await Promise.all(checks)).filter(
      (id): id is string => id !== null,
    );
    if (visible.length === 0) return;
    const previous = this.activeTargetId;
    const next = previous && visible.includes(previous) ? previous : visible[0];
    if (next === previous) return;
    this.activeTargetId = next;
    const prevTab = previous ? this.toTab(this.targets.get(previous)) : null;
    const nextTab = this.toTab(this.targets.get(next));
    if (prevTab) this.emit("tab-updated", prevTab);
    if (nextTab) this.emit("tab-updated", nextTab);
    this.schedulePersist();
  }

  /** listTabs() with a visibility refresh first — use when the caller needs
   * an accurate `active` flag rather than a cheap snapshot. */
  async listTabsFresh(): Promise<BrowserTab[]> {
    await this.refreshActiveTab();
    return this.listTabs();
  }

  async open(url: string): Promise<BrowserTab> {
    // With zero windows left macOS keeps Chromium running but plain
    // createTarget fails with "no browser is open" — open a fresh window.
    const noWindows = this.targets.size === 0;
    // A lone about:blank tab is launch debris — the buildArgs fallback used
    // when nothing was restored. Navigate it instead of stacking a second
    // tab, matching how Chrome replaces the initial new-tab page.
    const only = this.targets.size === 1 ? [...this.targets.values()][0] : null;
    if (only && (!only.url || only.url === "about:blank")) {
      const sessionId = await this.sessionFor(only.targetId);
      await this.cdp.send("Page.navigate", { url }, sessionId);
      this.activeTargetId = only.targetId;
      only.url = url;
      return this.toTab(only)!;
    }
    const result = (await this.cdp.send("Target.createTarget", {
      url,
      newWindow: noWindows,
      background: false,
    }).catch(async (error: unknown) => {
      if (error instanceof BrowserError && /no browser is open/i.test(error.message)) {
        return this.cdp.send("Target.createTarget", { url, newWindow: true, background: false });
      }
      throw error;
    })) as { targetId?: string } | undefined;
    const targetId = result?.targetId;
    if (!targetId) throw new BrowserError("cdp", "Target.createTarget returned no targetId");
    this.activeTargetId = targetId;
    // targetCreated may arrive after the reply; give the tracker a tick.
    if (!this.targets.has(targetId)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return (
      this.toTab(this.targets.get(targetId)) ?? {
        id: targetId,
        targetId,
        url,
        title: "",
        active: true,
      }
    );
  }

  async activate(id: string): Promise<BrowserTab> {
    this.requireTarget(id);
    await this.cdp.send("Target.activateTarget", { targetId: id });
    this.activeTargetId = id;
    const sessionId = this.sessions.get(id);
    if (sessionId) {
      await this.cdp.send("Page.bringToFront", {}, sessionId).catch(() => {});
    }
    const tab = this.toTab(this.targets.get(id));
    if (tab) {
      tab.active = true;
      this.emit("tab-updated", tab);
    }
    return tab!;
  }

  async close(id: string): Promise<{ ok: true }> {
    this.requireTarget(id);
    await this.cdp.send("Target.closeTarget", { targetId: id });
    this.targets.delete(id);
    this.sessions.delete(id);
    return { ok: true };
  }

  /** Close every chrome-extension:// page target. Extension pages
   * (welcome/onboarding/options) are ephemeral browser UI — they are never
   * restored from state.json, so any present right after launch were spawned
   * by extension onInstalled handlers (CDP loads are session-scoped and
   * count as fresh installs). Uses a fresh target list because the local
   * tracker lags behind targetCreated delivery. */
  async closeExtensionPages(): Promise<number> {
    const result = (await this.cdp.send("Target.getTargets")) as
      | { targetInfos?: TargetInfo[] }
      | undefined;
    let closed = 0;
    for (const info of result?.targetInfos ?? []) {
      if (info.type !== "page") continue;
      if (!String(info.url ?? "").startsWith("chrome-extension:")) continue;
      try {
        await this.cdp.send("Target.closeTarget", { targetId: info.targetId });
        this.targets.delete(info.targetId);
        this.sessions.delete(info.targetId);
        closed += 1;
      } catch {}
    }
    return closed;
  }

  async navigate(id: string, url: string): Promise<BrowserTab> {
    this.requireTarget(id);
    const sessionId = await this.sessionFor(id);
    await this.cdp.send("Page.navigate", { url }, sessionId);
    return this.toTab(this.targets.get(id))!;
  }

  private async navigateHistory(id: string, delta: -1 | 1): Promise<{ ok: true; skipped?: boolean }> {
    this.requireTarget(id);
    const sessionId = await this.sessionFor(id);
    const history = (await this.cdp.send("Page.getNavigationHistory", {}, sessionId)) as
      | { currentIndex?: number; entries?: { id: number }[] }
      | undefined;
    const entries = history?.entries ?? [];
    const currentIndex = history?.currentIndex ?? 0;
    const next = currentIndex + delta;
    const entry = entries[next];
    if (!entry) return { ok: true, skipped: true };
    await this.cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id }, sessionId);
    return { ok: true };
  }

  back(id: string): Promise<{ ok: true; skipped?: boolean }> {
    return this.navigateHistory(id, -1);
  }

  forward(id: string): Promise<{ ok: true; skipped?: boolean }> {
    return this.navigateHistory(id, 1);
  }

  async reload(id: string): Promise<{ ok: true }> {
    this.requireTarget(id);
    const sessionId = await this.sessionFor(id);
    await this.cdp.send("Page.reload", {}, sessionId);
    return { ok: true };
  }

  async evaluate(id: string, expression: string): Promise<unknown> {
    this.requireTarget(id);
    const sessionId = await this.sessionFor(id);
    const result = (await this.cdp.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    )) as
      | { result?: { value?: unknown }; exceptionDetails?: { text?: string } }
      | undefined;
    if (result?.exceptionDetails) {
      throw new BrowserError(
        "cdp",
        `Evaluation failed: ${result.exceptionDetails.text || "exception"}`,
      );
    }
    return result?.result?.value;
  }

  async extract(id: string, opts: { html?: boolean } = {}): Promise<{ url: string; title: string; text: string; html?: string }> {
    this.requireTarget(id);
    const sessionId = await this.sessionFor(id);
    const expression = `(() => {
      const text = (document.body && document.body.innerText) || "";
      return {
        url: location.href,
        title: document.title || "",
        text: text.length > ${EXTRACT_TEXT_CAP} ? text.slice(0, ${EXTRACT_TEXT_CAP}) : text,
        html: ${opts.html ? "document.documentElement.outerHTML" : "null"},
      };
    })()`;
    const result = (await this.cdp.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    )) as { result?: { value?: { url?: string; title?: string; text?: string; html?: string | null } } } | undefined;
    const value = result?.result?.value ?? {};
    return {
      url: value.url ?? "",
      title: value.title ?? "",
      text: value.text ?? "",
      ...(opts.html && typeof value.html === "string" ? { html: value.html } : {}),
    };
  }

  async screenshot(
    id: string,
    opts: { clip?: { x: number; y: number; width: number; height: number; scale?: number } } = {},
  ): Promise<Buffer> {
    this.requireTarget(id);
    const sessionId = await this.sessionFor(id);
    const params: Record<string, unknown> = { format: "png" };
    if (opts.clip) params.clip = { scale: 1, ...opts.clip };
    const result = (await this.cdp.send("Page.captureScreenshot", params, sessionId)) as
      | { data?: string }
      | undefined;
    if (!result?.data) throw new BrowserError("cdp", "Screenshot returned no data");
    return Buffer.from(result.data, "base64");
  }

  private activeOrFirstTarget(): string | null {
    if (this.activeTargetId && this.targets.has(this.activeTargetId)) {
      return this.activeTargetId;
    }
    const tabs = this.listTabs();
    return tabs[0]?.id ?? null;
  }

  async setWindowBounds(bounds: WindowBounds): Promise<{ ok: true }> {
    await this.refreshActiveTab();
    const targetId = this.activeOrFirstTarget();
    if (!targetId) throw new BrowserError("unavailable", "No browser tab to locate a window for");
    const win = (await this.cdp.send("Browser.getWindowForTarget", { targetId })) as
      | { windowId?: number; bounds?: Record<string, unknown> }
      | undefined;
    const windowId = win?.windowId;
    if (typeof windowId !== "number") {
      throw new BrowserError("cdp", "Browser.getWindowForTarget returned no windowId");
    }
    if (bounds.visible === false) {
      // Chrome for Testing on macOS ignores windowState:"minimized" (the
      // manager hides the app at process level instead), but other platforms
      // honor it.
      await this.cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "minimized" },
      });
    } else {
      if (bounds.visible === true) {
        await this.cdp.send("Browser.setWindowBounds", {
          windowId,
          bounds: { windowState: "normal" },
        });
      }
      const next: Record<string, number> = {};
      for (const [key, cdpKey] of [
        ["x", "left"],
        ["y", "top"],
        ["width", "width"],
        ["height", "height"],
      ] as const) {
        const value = bounds[key];
        if (typeof value === "number" && Number.isFinite(value)) {
          next[cdpKey] = Math.round(value);
        }
      }
      if (Object.keys(next).length > 0) {
        await this.cdp.send("Browser.setWindowBounds", { windowId, bounds: next });
      }
    }
    const realBounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    if (Object.values(realBounds).some((v) => typeof v === "number" && Number.isFinite(v))) {
      this.schedulePersist(realBounds);
    }
    return { ok: true };
  }

  async bringToFront(): Promise<{ ok: true }> {
    await this.refreshActiveTab();
    const targetId = this.activeOrFirstTarget();
    if (!targetId) throw new BrowserError("unavailable", "No browser tab to focus");
    const sessionId = await this.sessionFor(targetId);
    await this.cdp.send("Page.bringToFront", {}, sessionId);
    return { ok: true };
  }

  /** Session ids for open page targets (ExtensionManager uses the browser-level
   * connection for Extensions.*, but tests may need session routing). */
  sessionIdFor(id: string): Promise<string> {
    return this.sessionFor(id);
  }

  // ----- state.json persistence (last tab urls + bounds for relaunch restore)

  private schedulePersist(bounds?: { x?: number; y?: number; width?: number; height?: number }): void {
    if (bounds) this.pendingBounds = bounds;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistState().catch(() => {});
    }, 500);
  }

  private pendingBounds: { x?: number; y?: number; width?: number; height?: number } | null = null;

  private async persistState(): Promise<void> {
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(await fsp.readFile(browserStatePath(), "utf8")) as Record<string, unknown>;
    } catch {}
    // Ephemeral pages aren't worth restoring: about:blank launch debris and
    // chrome-extension:// pages (welcome/onboarding, options, the host
    // side-panel) are transient UI, not content the user browsed to.
    const restorable = (tabUrl: string) =>
      tabUrl !== "about:blank" && !tabUrl.startsWith("chrome-extension://");
    const tabs = this.listTabs()
      .map((tab) => tab.url)
      .filter(restorable);
    const active = this.listTabs().find((tab) => tab.active)?.url;
    const activeTab = active && restorable(active) ? active : undefined;
    const bounds = this.pendingBounds ?? (existing.bounds as Record<string, unknown> | undefined);
    const next = {
      ...existing,
      tabs,
      ...(activeTab ? { activeTab } : {}),
      ...(bounds ? { bounds } : {}),
    };
    this.pendingBounds = null;
    await fsp.mkdir(dirname(browserStatePath()), { recursive: true });
    const tmp = `${browserStatePath()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
    await fsp.rename(tmp, browserStatePath());
  }
}
