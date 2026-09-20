/**
 * Glue between the HTTP routes (BrowserFacade) and the concrete
 * ChromiumManager / BrowserSession / ExtensionManager trio. Also re-emits
 * per-session events on the manager so the daemon can broadcast them without
 * re-subscribing after every launch.
 */
import type { BrowserSession } from "./browser-session";
import { BrowserError, type BrowserTab } from "./types";
import { ChromiumManager, PINNED_CHROME_BUILD } from "./chromium-manager";
import { ExtensionManager } from "./extension-manager";
import type { BrowserFacade } from "./http";

export type BrowserDaemon = {
  manager: ChromiumManager;
  extensions: ExtensionManager;
  facade: BrowserFacade;
};

function requireSession(manager: ChromiumManager): BrowserSession {
  const session = manager.browserSession;
  if (!session || manager.status !== "running") {
    throw new BrowserError("unavailable", "Cabinet Browser is not running");
  }
  return session;
}

export function createBrowserDaemon(): BrowserDaemon {
  const extensionsHolder: { current: ExtensionManager | null } = { current: null };
  const manager = new ChromiumManager({
    // Web-store "Add to Cabinet" hook: install via the manager, then update
    // the button label in the page that invoked the binding.
    onInstallExtension: async (extensionId, sessionId) => {
      const cdp = manager.cdpClient;
      const setButton = (label: string, reenable: boolean) =>
        cdp
          ?.send(
            "Runtime.evaluate",
            {
              expression: `(function(){var b=document.querySelector("button[data-cabinet-install='1']:disabled");if(b){b.textContent=${JSON.stringify(label)};${reenable ? "b.disabled=false;" : ""}}})()`,
            },
            sessionId,
          )
          .catch(() => {});
      try {
        await extensionsHolder.current?.install(extensionId);
        await setButton("Installed", false);
      } catch {
        await setButton("Failed", true);
      }
    },
  });
  const extensions = new ExtensionManager({ getCdp: () => manager.cdpClient });
  extensionsHolder.current = extensions;

  manager.setLaunchHook(async (session) => {
    // Session events are per-launch; re-emit them on the manager so the
    // daemon's broadcast wiring survives relaunches.
    for (const kind of ["tab-created", "tab-updated", "tab-closed"] as const) {
      session.on(kind, (tab: BrowserTab) => manager.emit(kind, tab));
    }
    await extensions.migrateLegacyRecords();
    await extensions.applyAll();
    // Every launch is a fresh extension install (CDP loads are
    // session-scoped — Chrome purges them at exit), so onInstalled("install")
    // fires for each record. Extensions with welcome/onboarding pages open a
    // chrome-extension:// tab; those pages are never legitimate right after
    // launch (state.json restore filters them), so close them. The delayed
    // second pass catches deferred tab creations.
    await session.closeExtensionPages().catch(() => 0);
    const sweep = setTimeout(() => {
      void session.closeExtensionPages().catch(() => {});
    }, 3000);
    sweep.unref?.();
  });

  const facade: BrowserFacade = {
    status: () => manager.status,
    lastError: () => manager.lastError,
    executablePath: () => manager.executablePath,
    pid: () => manager.childPid,
    bundleId: () => manager.chromiumBundleId,
    hostMode: () => manager.hostMode,
    hostExtension: () => manager.hostExtension,
    version: () => PINNED_CHROME_BUILD,
    downloadProgress: () => manager.downloadProgress,
    isAvailable: (origin) => manager.isAvailable(origin),
    launch: () => manager.ensureRunning(),
    shutdown: () => manager.shutdown(),
    download: () => manager.download(),
    ensureRunning: () => manager.ensureRunning(),
    listTabs: () => manager.browserSession?.listTabsFresh() ?? Promise.resolve([]),
    openTab: async (url) => requireSession(manager).open(url),
    activateTab: async (id) => requireSession(manager).activate(id),
    closeTab: async (id) => requireSession(manager).close(id),
    navigateTab: async (id, url) => requireSession(manager).navigate(id, url),
    backTab: async (id) => requireSession(manager).back(id),
    forwardTab: async (id) => requireSession(manager).forward(id),
    reloadTab: async (id) => requireSession(manager).reload(id),
    evaluateTab: async (id, expression) => requireSession(manager).evaluate(id, expression),
    extractTab: async (id, opts) => requireSession(manager).extract(id, opts),
    screenshotTab: async (id) => requireSession(manager).screenshot(id),
    listExtensions: () => extensions.list(),
    installExtension: (idOrUrl) => extensions.install(idOrUrl),
    uninstallExtension: (id) => extensions.uninstall(id),
    enableExtension: (id) => extensions.enable(id),
    disableExtension: (id) => extensions.disable(id),
    pinExtension: (id, pinned) => extensions.setPinned(id, pinned),
    setWindowBounds: async (bounds) => {
      // Host mode lays tab content out inside the fork's own window, so the
      // floating-window bounds sync (and its OS-level hide/unhide) does not
      // apply.
      if (manager.hostMode) return { ok: true };
      if (bounds.visible === true) await manager.setAppHidden(false);
      const result = await requireSession(manager).setWindowBounds(bounds);
      if (bounds.visible === false) await manager.setAppHidden(true);
      return result;
    },
    focusWindow: async () => {
      if (manager.hostMode) return { ok: true };
      await manager.setAppHidden(false);
      const result = await requireSession(manager).bringToFront();
      return result;
    },
  };

  return { manager, extensions, facade };
}
