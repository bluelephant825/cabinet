"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  Bookmark,
  BookMarked,
  ChevronLeft,
  Pencil,
  ChevronRight,
  ExternalLink,
  Folder,
  Globe,
  Icon,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type { IconNode } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Header } from "@/components/layout/header";
import { useAppStore } from "@/stores/app-store";
import { useLocale } from "@/i18n/use-locale";

type BrowserViewBounds = { x: number; y: number; width: number; height: number };
type BrowserViewNavResult = {
  ok: boolean;
  skipped?: boolean;
  error?: string;
  loadedUrl?: string;
  primaryUrl?: string;
  fallbackUrl?: string | null;
  primaryError?: string;
  fallbackError?: string;
};
type BrowserBookmarkMenuItem = {
  id: string;
  name: string;
  type: "url" | "folder";
  url?: string;
  children?: BrowserBookmarkMenuItem[];
};

type BrowserBridge = {
  runtime: "electron";
  createBrowserView: (url: string) => Promise<{ ok: boolean; viewId?: string }>;
  loadBrowserViewUrl: (viewId: string, url: string) => Promise<BrowserViewNavResult>;
  setBrowserViewBounds: (viewId: string, bounds: BrowserViewBounds) => Promise<{ ok: boolean }>;
  setBrowserViewVisible: (viewId: string, visible: boolean) => Promise<{ ok: boolean }>;
  browserViewGoBack: (viewId: string) => Promise<BrowserViewNavResult>;
  browserViewGoForward: (viewId: string) => Promise<BrowserViewNavResult>;
  browserViewReload: (viewId: string) => Promise<BrowserViewNavResult>;
  showBrowserBookmarksMenu: (payload: {
    x: number;
    y: number;
    items: BrowserBookmarkMenuItem[];
  }) => Promise<{ ok: boolean; cancelled?: boolean; id?: string; url?: string }>;
  onBrowserViewNavigated: (
    listener: (payload: { viewId?: string; url?: string }) => void
  ) => () => void;
  onBrowserViewLoadFailed: (
    listener: (payload: {
      viewId?: string;
      requestedUrl?: string;
      primaryUrl?: string;
      fallbackUrl?: string;
      primaryError?: string;
      fallbackError?: string;
      errorCode?: number;
      errorDescription?: string;
      validatedUrl?: string;
    }) => void
  ) => () => void;
  destroyBrowserView: (viewId: string) => Promise<{ ok: boolean }>;
};

type BrowserSessionState = {
  history: string[];
  index: number;
  url: string | null;
};

type BookmarkUrlNode = {
  id: string;
  name: string;
  type: "url";
  url: string;
  date_added: string;
  date_last_used: string;
};

type BookmarkFolderNode = {
  id: string;
  name: string;
  type: "folder";
  date_added: string;
  date_modified: string;
  children: BookmarkNode[];
};

type BookmarkNode = BookmarkUrlNode | BookmarkFolderNode;

type BookmarkFile = {
  checksum: string;
  roots: {
    bookmark_bar: BookmarkFolderNode;
    other: BookmarkFolderNode;
  };
  version: number;
};

const BROWSER_SESSION_STORAGE_KEY = "cabinet.browser.session";

function normalizeBookmarkNodes(nodes: BookmarkNode[]): BookmarkNode[] {
  return [...nodes].sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "folder" ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

function normalizeBookmarkUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "about:blank";
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed) || trimmed.startsWith("//")) return trimmed;
  return `https://${trimmed}`;
}

function toBridgeBookmarkMenuItems(nodes: BookmarkNode[]): BrowserBookmarkMenuItem[] {
  return normalizeBookmarkNodes(nodes).map((node) => {
    if (node.type === "folder") {
      return {
        id: node.id,
        name: node.name,
        type: "folder",
        children: toBridgeBookmarkMenuItems(node.children),
      };
    }
    return {
      id: node.id,
      name: node.name,
      type: "url",
      url: node.url,
    };
  });
}

function getBridge(): Partial<BrowserBridge> & { runtime?: "electron" } {
  return (window as unknown as { CabinetDesktop?: Partial<BrowserBridge> & { runtime?: "electron" } })
    .CabinetDesktop ?? {};
}

function normalizeEnteredUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../")) {
    if (typeof window !== "undefined") {
      try {
        return new URL(trimmed, window.location.origin).toString();
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed) || trimmed.startsWith("//")) return trimmed;
  return `https://${trimmed}`;
}

const folderBookmarkIconNode: IconNode = [
  ["path", { d: "M12 6v8l3-3 3 3V6", key: "v0froi" }],
  [
    "path",
    {
      d: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z",
      key: "1wvlfi",
    },
  ],
];

function normalizeSessionUrl(value: string | null | undefined): string {
  const trimmed = (value || "about:blank").trim();
  return trimmed || "about:blank";
}

function loadBrowserSessionState(): BrowserSessionState {
  if (typeof window === "undefined") {
    return { history: ["about:blank"], index: 0, url: "about:blank" };
  }
  try {
    const raw = window.sessionStorage.getItem(BROWSER_SESSION_STORAGE_KEY);
    if (!raw) {
      return { history: ["about:blank"], index: 0, url: "about:blank" };
    }
    const parsed = JSON.parse(raw) as {
      history?: unknown;
      index?: unknown;
      url?: unknown;
    };
    const history = Array.isArray(parsed.history)
      ? parsed.history.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [];
    const cleanedHistory = history.length > 0 ? history.map((entry) => normalizeSessionUrl(entry)) : ["about:blank"];
    const nextIndex =
      typeof parsed.index === "number" && Number.isFinite(parsed.index)
        ? Math.max(0, Math.min(cleanedHistory.length - 1, Math.floor(parsed.index)))
        : cleanedHistory.length - 1;
    const nextUrl =
      typeof parsed.url === "string" && parsed.url.trim().length > 0
        ? normalizeSessionUrl(parsed.url)
        : cleanedHistory[nextIndex] || "about:blank";
    return {
      history: cleanedHistory,
      index: nextIndex,
      url: nextUrl,
    };
  } catch {
    return { history: ["about:blank"], index: 0, url: "about:blank" };
  }
}

function persistBrowserSessionState(state: BrowserSessionState): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(BROWSER_SESSION_STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

export function BrowserView() {
  const { t } = useLocale();
  const url = useAppStore((s) => s.browseUrl);
  const setAppMode = useAppStore((s) => s.setAppMode);
  const initialSessionRef = useRef<BrowserSessionState>(loadBrowserSessionState());
  const [addressValue, setAddressValue] = useState(url ?? initialSessionRef.current.url ?? "");
  const [browserMode, setBrowserMode] = useState<"initializing" | "electron" | "iframe">(() => {
    const bridge = getBridge();
    return bridge.createBrowserView && bridge.destroyBrowserView ? "initializing" : "iframe";
  });
  const [fallbackReason, setFallbackReason] = useState<string | null>(null);
  const [initAttempt, setInitAttempt] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const bookmarksMenuRef = useRef<HTMLDivElement | null>(null);
  const bookmarksTriggerRef = useRef<HTMLButtonElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const iframeLoadTokenRef = useRef(0);
  const iframeLoadedTokenRef = useRef(0);
  const [iframeLoadedToken, setIframeLoadedToken] = useState(0);
  const iframeHistoryRef = useRef<string[]>(initialSessionRef.current.history);
  const iframeHistoryIndexRef = useRef<number>(initialSessionRef.current.index);
  const iframeNavActionRef = useRef<"back" | "forward" | null>(null);
  const suppressNextElectronLoadRef = useRef(false);
  const [iframeReloadKey, setIframeReloadKey] = useState(0);
  const viewIdRef = useRef<string | null>(null);
  const updateBoundsRef = useRef<() => void>(() => {});
  const [iframeFailure, setIframeFailure] = useState<string | null>(null);
  const [electronFailure, setElectronFailure] = useState<string | null>(null);
  const [iframePolicyBlocked, setIframePolicyBlocked] = useState(false);
  const [bookmarks, setBookmarks] = useState<BookmarkFile | null>(null);
  const [bookmarksLoading, setBookmarksLoading] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [bookmarksMenuOpen, setBookmarksMenuOpen] = useState(false);
  const [bookmarksMenuPosition, setBookmarksMenuPosition] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [bookmarksBarVisible, setBookmarksBarVisible] = useState(true);

  useEffect(() => {
    if (url == null) return;
    setAddressValue(url);
  }, [url]);

  const fetchBookmarks = async () => {
    setBookmarksLoading(true);
    try {
      const response = await fetch("/api/browser/bookmarks", { method: "GET", cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as BookmarkFile;
      setBookmarks(data);
    } finally {
      setBookmarksLoading(false);
    }
  };

  const addCurrentPageAsBookmark = async () => {
    if (!url || url === "about:blank") return;
    const payload = {
      action: "addBookmark",
      name: (() => {
        if (browserMode === "iframe") {
          try {
            return iframeRef.current?.contentDocument?.title || url;
          } catch {
            return url;
          }
        }
        return url;
      })(),
      url,
    };
    const response = await fetch("/api/browser/bookmarks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) return;
    const data = (await response.json()) as { bookmarks?: BookmarkFile };
    if (data.bookmarks) setBookmarks(data.bookmarks);
  };

  const markBookmarkUsed = async (id: string) => {
    const response = await fetch("/api/browser/bookmarks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "markUsed", id }),
    });
    if (!response.ok) return;
    const data = (await response.json()) as { bookmarks?: BookmarkFile };
    if (data.bookmarks) setBookmarks(data.bookmarks);
  };

  const openBookmarkUrl = async (node: BookmarkUrlNode) => {
    await markBookmarkUsed(node.id);
    setBookmarksMenuOpen(false);
    setAppMode("browse", node.url);
    setAddressValue(node.url);
  };

  const openBookmarksNativeMenu = async () => {
    const trigger = bookmarksTriggerRef.current;
    if (!trigger) return;
    const bridge = getBridge();
    const showBrowserBookmarksMenu = bridge.showBrowserBookmarksMenu;
    if (!showBrowserBookmarksMenu) {
      setBookmarksMenuOpen((open) => !open);
      return;
    }
    if (!bookmarks) {
      return;
    }

    const rect = trigger.getBoundingClientRect();
    const x = Math.max(0, Math.round(rect.right - 4));
    const y = Math.max(0, Math.round(rect.bottom + 6));
    const items = toBridgeBookmarkMenuItems([
      ...bookmarks.roots.bookmark_bar.children,
      ...bookmarks.roots.other.children,
    ]);

    const result = await showBrowserBookmarksMenu({ x, y, items });
    if (!result?.ok || result.cancelled) return;
    if (typeof result.id === "string") {
      await markBookmarkUsed(result.id);
    }
    if (typeof result.url === "string" && result.url.trim().length > 0) {
      setAppMode("browse", result.url);
      setAddressValue(result.url);
    }
  };

  const createFolder = async () => {
    const response = await fetch("/api/browser/bookmarks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "createFolder", name: "New Folder" }),
    });
    if (!response.ok) return;
    const data = (await response.json()) as { bookmarks?: BookmarkFile };
    if (data.bookmarks) setBookmarks(data.bookmarks);
  };

  const updateNode = async (id: string, payload: { name: string; url?: string }) => {
    const response = await fetch("/api/browser/bookmarks", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...payload }),
    });
    if (!response.ok) return;
    const data = (await response.json()) as { bookmarks?: BookmarkFile };
    if (data.bookmarks) setBookmarks(data.bookmarks);
  };

  const deleteNode = async (id: string) => {
    const response = await fetch("/api/browser/bookmarks", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!response.ok) return;
    const data = (await response.json()) as { bookmarks?: BookmarkFile };
    if (data.bookmarks) setBookmarks(data.bookmarks);
  };

  const navigateBack = () => {
    const applyAppHistoryBack = () => {
      const nextIndex = iframeHistoryIndexRef.current - 1;
      if (nextIndex < 0) return;
      iframeHistoryIndexRef.current = nextIndex;
      iframeNavActionRef.current = "back";
      setAppMode("browse", iframeHistoryRef.current[nextIndex] || "about:blank");
    };
    if (browserMode === "electron") {
      const viewId = viewIdRef.current;
      const bridge = getBridge();
      if (viewId && bridge.browserViewGoBack) {
        iframeNavActionRef.current = "back";
        void bridge.browserViewGoBack(viewId)
          .then((result) => {
            if (result?.ok && !result.skipped) return;
            iframeNavActionRef.current = null;
            applyAppHistoryBack();
          })
          .catch(() => {
            iframeNavActionRef.current = null;
            applyAppHistoryBack();
          });
        return;
      }
      applyAppHistoryBack();
      return;
    }
    if (browserMode === "iframe") {
      try {
        iframeRef.current?.contentWindow?.history.back();
        return;
      } catch {
        applyAppHistoryBack();
      }
    }
  };

  const navigateForward = () => {
    const applyAppHistoryForward = () => {
      const nextIndex = iframeHistoryIndexRef.current + 1;
      if (nextIndex >= iframeHistoryRef.current.length) return;
      iframeHistoryIndexRef.current = nextIndex;
      iframeNavActionRef.current = "forward";
      setAppMode("browse", iframeHistoryRef.current[nextIndex] || "about:blank");
    };
    if (browserMode === "electron") {
      const viewId = viewIdRef.current;
      const bridge = getBridge();
      if (viewId && bridge.browserViewGoForward) {
        iframeNavActionRef.current = "forward";
        void bridge.browserViewGoForward(viewId)
          .then((result) => {
            if (result?.ok && !result.skipped) return;
            iframeNavActionRef.current = null;
            applyAppHistoryForward();
          })
          .catch(() => {
            iframeNavActionRef.current = null;
            applyAppHistoryForward();
          });
        return;
      }
      applyAppHistoryForward();
      return;
    }
    if (browserMode === "iframe") {
      applyAppHistoryForward();
    }
  };

  const reloadPage = () => {
    const applyReloadFallback = () => {
      setIframeReloadKey((k) => k + 1);
    };
    if (browserMode === "electron") {
      const viewId = viewIdRef.current;
      const bridge = getBridge();
      if (!viewId) {
        applyReloadFallback();
        return;
      }
      if (bridge.browserViewReload) {
        void bridge.browserViewReload(viewId)
          .then((result) => {
            if (result?.ok && !result.skipped) return;
            if (bridge.loadBrowserViewUrl) {
              void bridge.loadBrowserViewUrl(viewId, "__cabinet_nav_reload__")
                .then((fallbackResult) => {
                  if (fallbackResult?.ok && !fallbackResult.skipped) return;
                  applyReloadFallback();
                })
                .catch(() => {
                  applyReloadFallback();
                });
              return;
            }
            applyReloadFallback();
          })
          .catch(() => {
            if (bridge.loadBrowserViewUrl) {
              void bridge.loadBrowserViewUrl(viewId, "__cabinet_nav_reload__")
                .then((fallbackResult) => {
                  if (fallbackResult?.ok && !fallbackResult.skipped) return;
                  applyReloadFallback();
                })
                .catch(() => {
                  applyReloadFallback();
                });
              return;
            }
            applyReloadFallback();
          });
        return;
      }
      if (bridge.loadBrowserViewUrl) {
        void bridge.loadBrowserViewUrl(viewId, "__cabinet_nav_reload__")
          .then((result) => {
            if (result?.ok && !result.skipped) return;
            applyReloadFallback();
          })
          .catch(() => {
            applyReloadFallback();
          });
        return;
      }
      applyReloadFallback();
      return;
    }
    if (browserMode === "iframe") {
      applyReloadFallback();
    }
  };

  useEffect(() => {
    let cancelled = false;
    let retries = 0;
    const maxRetries = 20;
    let retryTimer: number | null = null;

    const cleanup = () => {
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const failToIframe = (reason: string) => {
      setBrowserMode("iframe");
      setFallbackReason(reason);
    };

    const hasElectronBrowserBridge = () => {
      const bridge = getBridge();
      return !!bridge.createBrowserView && !!bridge.destroyBrowserView;
    };

    const attemptInit = () => {
      if (cancelled) return;
      const bridge = getBridge();
      if (!hasElectronBrowserBridge()) {
        retries += 1;
        if (retries >= maxRetries) {
          failToIframe("bridge-unavailable");
          return;
        }
        retryTimer = window.setTimeout(attemptInit, 100);
        return;
      }
      const createBrowserView = bridge.createBrowserView;
      const destroyBrowserView = bridge.destroyBrowserView;
      const loadBrowserViewUrl = bridge.loadBrowserViewUrl;
      if (!createBrowserView || !destroyBrowserView) {
        failToIframe("bridge-method-missing");
        return;
      }
      void createBrowserView(url || "about:blank")
        .then((result) => {
          if (cancelled) return;
          if (!result?.ok || !result.viewId) {
            failToIframe("create-browser-view-failed");
            return;
          }
          setBrowserMode("electron");
          setFallbackReason(null);
          setElectronFailure(null);
          viewIdRef.current = result.viewId;
          updateBoundsRef.current();
          const activeUrl = useAppStore.getState().browseUrl || "about:blank";
          if (loadBrowserViewUrl) {
            void loadBrowserViewUrl(result.viewId, activeUrl)
              .then((navResult) => {
                if (!navResult?.ok) {
                  setElectronFailure(navResult?.primaryError || navResult?.error || "load-failed");
                }
              })
              .catch(() => {
                setElectronFailure("load-failed");
              });
          }
        })
        .catch(() => {
          if (!cancelled) failToIframe("create-browser-view-threw");
        });
    };

    const existing = viewIdRef.current;
    if (existing) {
      const bridge = getBridge();
      const destroyBrowserView = bridge.destroyBrowserView;
      const setBrowserViewVisible = bridge.setBrowserViewVisible;
      viewIdRef.current = null;
      if (setBrowserViewVisible) {
        void setBrowserViewVisible(existing, false).catch(() => {});
      }
      if (destroyBrowserView) {
        void destroyBrowserView(existing);
      }
    }

    setBrowserMode(hasElectronBrowserBridge() ? "initializing" : "iframe");
    setFallbackReason(null);
    attemptInit();

    return () => {
      cancelled = true;
      cleanup();
      const bridge = getBridge();
      const destroyBrowserView = bridge.destroyBrowserView;
      const setBrowserViewVisible = bridge.setBrowserViewVisible;
      const current = viewIdRef.current;
      viewIdRef.current = null;
      if (current && setBrowserViewVisible) {
        void setBrowserViewVisible(current, false).catch(() => {});
      }
      if (current && destroyBrowserView) {
        void destroyBrowserView(current);
      }
    };
  }, [initAttempt]);

  useEffect(() => {
    const bridge = getBridge();
    const subscribe = bridge.onBrowserViewLoadFailed;
    if (!subscribe) return;
    const unsubscribe = subscribe((payload) => {
      const activeViewId = viewIdRef.current;
      if (!activeViewId || payload?.viewId !== activeViewId) return;
      const detail = [
        payload?.errorDescription,
        payload?.validatedUrl,
        payload?.primaryError,
        payload?.fallbackError,
      ]
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .join(" | ");
      setElectronFailure(detail || "load-failed");
    });
    return () => {
      unsubscribe();
    };
  }, []);


  useEffect(() => {
    const bridge = getBridge();
    const subscribe = bridge.onBrowserViewNavigated;
    if (!subscribe) return;
    const unsubscribe = subscribe((payload) => {
      const activeViewId = viewIdRef.current;
      if (!activeViewId || payload?.viewId !== activeViewId) return;
      const nextUrl = normalizeSessionUrl(payload?.url || "about:blank");
      const history = iframeHistoryRef.current;
      const currentIndex = iframeHistoryIndexRef.current;
      const navAction = iframeNavActionRef.current;
      if (navAction === "back" || navAction === "forward") {
        iframeNavActionRef.current = null;
        let nextIndex = navAction === "back" ? Math.max(0, currentIndex - 1) : Math.min(history.length - 1, currentIndex + 1);
        if (history[nextIndex] !== nextUrl) {
          const start = navAction === "back" ? Math.max(0, currentIndex - 1) : Math.min(history.length - 1, currentIndex + 1);
          const end = navAction === "back" ? 0 : history.length - 1;
          const step = navAction === "back" ? -1 : 1;
          let matchedIndex = -1;
          for (let i = start; navAction === "back" ? i >= end : i <= end; i += step) {
            if (history[i] === nextUrl) {
              matchedIndex = i;
              break;
            }
          }
          if (matchedIndex >= 0) {
            nextIndex = matchedIndex;
          } else {
            const nextHistory = currentIndex >= 0 ? history.slice(0, currentIndex + 1) : [];
            nextHistory.push(nextUrl);
            iframeHistoryRef.current = nextHistory;
            nextIndex = nextHistory.length - 1;
          }
        }
        iframeHistoryIndexRef.current = nextIndex;
        const nextHistory = iframeHistoryRef.current;
        persistBrowserSessionState({ history: nextHistory, index: nextIndex, url: nextUrl });
        setAddressValue(nextUrl);
        if (useAppStore.getState().browseUrl !== nextUrl) {
          suppressNextElectronLoadRef.current = true;
          setAppMode("browse", nextUrl);
        }
        return;
      }
      if (currentIndex >= 0 && history[currentIndex] === nextUrl) {
        persistBrowserSessionState({ history, index: currentIndex, url: nextUrl });
        setAddressValue(nextUrl);
        return;
      }
      const nextHistory = currentIndex >= 0 ? history.slice(0, currentIndex + 1) : [];
      nextHistory.push(nextUrl);
      iframeHistoryRef.current = nextHistory;
      iframeHistoryIndexRef.current = nextHistory.length - 1;
      persistBrowserSessionState({
        history: nextHistory,
        index: iframeHistoryIndexRef.current,
        url: nextUrl,
      });
      setAddressValue(nextUrl);
      if (useAppStore.getState().browseUrl !== nextUrl) {
        suppressNextElectronLoadRef.current = true;
        setAppMode("browse", nextUrl);
      }
    });
    return () => {
      unsubscribe();
    };
  }, [setAppMode]);

  useEffect(() => {
    const bridge = getBridge();
    const viewId = viewIdRef.current;
    if (!bridge.createBrowserView || !bridge.destroyBrowserView || !viewId || browserMode !== "electron") {
      return;
    }
    if (suppressNextElectronLoadRef.current) {
      suppressNextElectronLoadRef.current = false;
      return;
    }
    const loadBrowserViewUrl = bridge.loadBrowserViewUrl;
    if (!loadBrowserViewUrl) return;
    void loadBrowserViewUrl(viewId, url || "about:blank")
      .then((result) => {
        if (!result?.ok) {
          setElectronFailure(result?.primaryError || result?.error || "load-failed");
        } else {
          setElectronFailure(null);
        }
      })
      .catch(() => {
        setElectronFailure("load-failed");
      });
  }, [url, browserMode]);

  useEffect(() => {
    const bridge = getBridge();
    if (!bridge.createBrowserView || !bridge.destroyBrowserView || browserMode !== "electron") return;
    const setBrowserViewBounds = bridge.setBrowserViewBounds;
    if (!setBrowserViewBounds) return;
    const updateBounds = () => {
      const viewId = viewIdRef.current;
      const el = containerRef.current;
      if (!viewId || !el) return;
      const rect = el.getBoundingClientRect();
      const x = Math.max(0, Math.round(rect.left));
      const y = Math.max(0, Math.round(rect.top));
      const width = Math.max(0, Math.round(rect.width));
      const height = Math.max(0, Math.round(rect.height));
      if (width < 64 || height < 64) return;
      void setBrowserViewBounds(viewId, { x, y, width, height });
    };
    updateBoundsRef.current = updateBounds;
    const ro = new ResizeObserver(updateBounds);
    const el = containerRef.current;
    if (el) ro.observe(el);
    window.addEventListener("resize", updateBounds);
    updateBounds();
    const timer = window.setTimeout(updateBounds, 120);
    return () => {
      window.clearTimeout(timer);
      updateBoundsRef.current = () => {};
      ro.disconnect();
      window.removeEventListener("resize", updateBounds);
    };
  }, [browserMode]);

  useEffect(() => {
    const bridge = getBridge();
    const viewId = viewIdRef.current;
    if (!bridge.createBrowserView || !bridge.destroyBrowserView || !viewId || browserMode !== "electron") {
      return;
    }
    const setBrowserViewVisible = bridge.setBrowserViewVisible;
    if (!setBrowserViewVisible) return;
    const shouldShow = !managerOpen;
    if (shouldShow) {
      updateBoundsRef.current();
    }
    void setBrowserViewVisible(viewId, shouldShow)
      .then((result) => {
        if (shouldShow) {
          window.setTimeout(() => {
            updateBoundsRef.current();
          }, 24);
        }
        if (shouldShow && !result?.ok) {
          setInitAttempt((value) => value + 1);
        }
      })
      .catch(() => {
        if (shouldShow) {
          setInitAttempt((value) => value + 1);
        }
      });
  }, [browserMode, managerOpen]);

  useEffect(() => {
    if (browserMode !== "iframe") {
      setIframePolicyBlocked(false);
      return;
    }
    if (!url || url === "about:blank") {
      setIframePolicyBlocked(false);
      return;
    }
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch(`/api/browser/frame-check?url=${encodeURIComponent(url)}`, {
          method: "GET",
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) {
          setIframePolicyBlocked(data?.blocked === true);
        }
      } catch {
        if (!cancelled) {
          setIframePolicyBlocked(false);
        }
      }
    };
    void check();
    return () => {
      cancelled = true;
    };
  }, [browserMode, url]);

  useEffect(() => {
    if (browserMode !== "iframe") {
      setIframeFailure(null);
      return;
    }
    if (!url || url === "about:blank") {
      setIframeFailure(null);
      return;
    }
    const loadToken = iframeLoadTokenRef.current;
    const timer = window.setTimeout(() => {
      if (iframePolicyBlocked) {
        setIframeFailure("blocked-or-failed");
        return;
      }
      if (iframeLoadedTokenRef.current < loadToken) {
        setIframeFailure("blocked-or-failed");
        return;
      }
      const iframe = iframeRef.current;
      if (!iframe) {
        setIframeFailure("blocked-or-failed");
        return;
      }
      try {
        const href = iframe.contentWindow?.location?.href || "";
        const doc = iframe.contentDocument;
        const title = (doc?.title || "").toLowerCase();
        const bodyText = (doc?.body?.innerText || "").toLowerCase();
        const hasConnectionErrorText =
          bodyText.includes("refused to connect") ||
          bodyText.includes("can't be reached") ||
          bodyText.includes("cannot be reached") ||
          bodyText.includes("connection") && bodyText.includes("failed");
        if (
          href === "about:blank" ||
          href.startsWith("chrome-error://") ||
          title.includes("error") ||
          hasConnectionErrorText
        ) {
          setIframeFailure("blocked-or-failed");
          return;
        }
      } catch {
        setIframeFailure(null);
        return;
      }
      setIframeFailure(null);
    }, 2500);
    return () => {
      window.clearTimeout(timer);
    };
  }, [browserMode, url, iframeLoadedToken, iframePolicyBlocked]);

  useEffect(() => {
    void fetchBookmarks();
  }, []);

  useEffect(() => {
    if (!bookmarksMenuOpen) {
      setBookmarksMenuPosition(null);
      return;
    }
    const updatePosition = () => {
      const trigger = bookmarksTriggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const menuWidth = 320;
      const left = Math.max(8, Math.min(window.innerWidth - menuWidth - 8, rect.right - menuWidth));
      const top = Math.max(8, rect.bottom + 6);
      const maxHeight = Math.max(120, window.innerHeight - top - 8);
      setBookmarksMenuPosition({ top, left, maxHeight });
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      const menu = bookmarksMenuRef.current;
      const trigger = bookmarksTriggerRef.current;
      if (menu?.contains(target) || trigger?.contains(target)) return;
      setBookmarksMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setBookmarksMenuOpen(false);
      }
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [bookmarksMenuOpen]);

  const allTopLevelNodes = bookmarks
    ? normalizeBookmarkNodes([
        ...bookmarks.roots.bookmark_bar.children,
        ...bookmarks.roots.other.children,
      ])
    : [];

  const bookmarkBarNodes = bookmarks
    ? normalizeBookmarkNodes(bookmarks.roots.bookmark_bar.children).filter(
        (node): node is BookmarkUrlNode => node.type === "url"
      )
    : [];

  const renderDropdownNodes = (nodes: BookmarkNode[], depth = 0): ReactNode => {
    return normalizeBookmarkNodes(nodes).map((node) => {
      if (node.type === "folder") {
        return (
          <div key={node.id} className="space-y-1">
            <div
              className="flex items-center gap-2 px-2 py-1 text-xs font-medium text-muted-foreground"
              style={{ marginLeft: `${depth * 10}px` }}
            >
              <Folder className="h-3.5 w-3.5" />
              <span className="truncate">{node.name}</span>
            </div>
            {node.children.length > 0 ? (
              renderDropdownNodes(node.children, depth + 1)
            ) : (
              <div className="px-2 py-1 text-xs text-muted-foreground" style={{ marginLeft: `${(depth + 1) * 10}px` }}>
                Empty
              </div>
            )}
          </div>
        );
      }
      return (
        <button
          key={node.id}
          type="button"
          onClick={() => {
            void openBookmarkUrl(node);
          }}
          className="flex w-full items-center rounded px-2 py-1.5 text-left text-sm text-foreground hover:bg-muted"
          style={{ marginLeft: `${depth * 10}px` }}
        >
          <span className="truncate">{node.name}</span>
        </button>
      );
    });
  };

  const renderManagerNodes = (nodes: BookmarkNode[], depth = 0): ReactNode => {
    return normalizeBookmarkNodes(nodes).map((node) => {
      const isEditing = editingNodeId === node.id;
      return (
        <div key={node.id} className="space-y-1">
          <div className="flex items-center gap-2 rounded border border-border/70 px-2 py-1">
            <div style={{ marginLeft: `${depth * 14}px` }} className="flex items-center gap-1.5 min-w-0 flex-1">
              {isEditing ? (
                <>
                  <input
                    value={editName}
                    onChange={(event) => setEditName(event.target.value)}
                    className="h-7 min-w-0 flex-1 rounded border border-border bg-background px-2 text-xs"
                  />
                  {node.type === "url" ? (
                    <input
                      value={editUrl}
                      onChange={(event) => setEditUrl(event.target.value)}
                      className="h-7 min-w-0 flex-1 rounded border border-border bg-background px-2 text-xs"
                    />
                  ) : null}
                  <button
                    type="button"
                    className="inline-flex h-7 items-center rounded border border-border px-2 text-xs hover:bg-muted"
                    onClick={() => {
                      void updateNode(node.id, {
                        name: editName,
                        ...(node.type === "url" ? { url: normalizeBookmarkUrl(editUrl) } : {}),
                      }).then(() => {
                        setEditingNodeId(null);
                      });
                    }}
                  >
                    Save
                  </button>
                </>
              ) : (
                <>
                  <span className="truncate text-xs text-foreground">{node.name}</span>
                  {node.type === "url" ? (
                    <span className="truncate text-[11px] text-muted-foreground">{node.url}</span>
                  ) : null}
                </>
              )}
            </div>
            {!isEditing ? (
              <>
                <button
                  type="button"
                  className="inline-flex h-7 w-7 items-center justify-center rounded border border-border hover:bg-muted"
                  onClick={() => {
                    setEditingNodeId(node.id);
                    setEditName(node.name);
                    setEditUrl(node.type === "url" ? node.url : "");
                  }}
                  title="Edit"
                  aria-label="Edit"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  className="inline-flex h-7 w-7 items-center justify-center rounded border border-border text-destructive hover:bg-destructive/10"
                  onClick={() => {
                    void deleteNode(node.id);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </>
            ) : null}
          </div>
          {node.type === "folder" && node.children.length > 0 ? renderManagerNodes(node.children, depth + 1) : null}
        </div>
      );
    });
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <Header />
      <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
        <div className="grid grid-cols-[1fr_minmax(0,720px)_1fr] items-center gap-3 border-b border-border/70 bg-background/80 px-4 py-2 text-sm text-muted-foreground">
          <div className="flex items-center gap-2 truncate">
            <button
              type="button"
              onClick={() => setBookmarksBarVisible((visible) => !visible)}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-transparent text-foreground hover:border-border hover:bg-muted"
              aria-label={bookmarksBarVisible ? "Hide bookmarks bar" : "Show bookmarks bar"}
              title={bookmarksBarVisible ? "Hide bookmarks bar" : "Show bookmarks bar"}
            >
              <Globe className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={navigateBack}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-transparent text-foreground hover:border-border hover:bg-muted"
              aria-label={t("editor:browser.back")}
              title={t("editor:browser.back")}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={navigateForward}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-transparent text-foreground hover:border-border hover:bg-muted"
              aria-label={t("editor:browser.forward")}
              title={t("editor:browser.forward")}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={reloadPage}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-transparent text-foreground hover:border-border hover:bg-muted"
              aria-label={t("editor:browser.reload")}
              title={t("editor:browser.reload")}
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={addressValue}
              onChange={(event) => setAddressValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                const nextUrl = normalizeEnteredUrl(addressValue);
                setAppMode("browse", nextUrl);
                setAddressValue(nextUrl ?? "");
              }}
              placeholder={t("editor:browser.noUrl")}
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground shadow-sm outline-none ring-offset-background focus:ring-2 focus:ring-ring"
            />
            <button
              type="button"
              onClick={() => void addCurrentPageAsBookmark()}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-transparent text-foreground hover:border-border hover:bg-muted"
              title="Save bookmark"
              aria-label="Save bookmark"
            >
              <Bookmark className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                setManagerOpen(true);
                setEditingNodeId(null);
              }}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-transparent text-foreground hover:border-border hover:bg-muted"
              title="Bookmark manager"
              aria-label="Bookmark manager"
            >
              <BookMarked className="h-4 w-4" />
            </button>
            <button
              ref={bookmarksTriggerRef}
              type="button"
              onClick={() => {
                void openBookmarksNativeMenu();
              }}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-transparent text-foreground hover:border-border hover:bg-muted"
              title="Bookmarks"
              aria-label="Bookmarks"
              aria-expanded={bookmarksMenuOpen}
            >
              <Icon iconNode={folderBookmarkIconNode} className="h-4 w-4" />
            </button>
          </div>
          <div className="flex justify-end gap-2">
            {url ? (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-muted"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {t("editor:browser.openExternally")}
              </a>
            ) : null}
          </div>
        </div>
        {bookmarksBarVisible ? (
          <div className="border-b border-border/70 bg-background/80 px-4 py-1.5">
            <div className="flex items-center gap-1.5 overflow-x-auto">
              {bookmarkBarNodes.length > 0 ? (
                bookmarkBarNodes.map((node) => (
                  <button
                    key={node.id}
                    type="button"
                    onClick={() => {
                      void openBookmarkUrl(node);
                    }}
                    className="inline-flex h-7 max-w-[220px] shrink-0 items-center rounded-md border border-transparent px-2 text-xs text-foreground hover:border-border hover:bg-muted"
                    title={node.name}
                    aria-label={node.name}
                  >
                    <span className="truncate">{node.name}</span>
                  </button>
                ))
              ) : (
                <div className="px-1 text-xs text-muted-foreground">No bookmarks in Bookmarks bar</div>
              )}
            </div>
          </div>
        ) : null}
        <div ref={containerRef} className="relative flex-1 min-h-0">
          {browserMode === "iframe" ? (
            <>
              <iframe
                key={`${url || "about:blank"}:${iframeReloadKey}`}
                ref={iframeRef}
                title={t("editor:browser.openExternally")}
                src={url || "about:blank"}
                onLoad={() => {
                  iframeLoadedTokenRef.current = iframeLoadTokenRef.current;
                  setIframeLoadedToken(iframeLoadTokenRef.current);
                }}
                className="h-full w-full border-0 bg-white"
                sandbox="allow-same-origin allow-scripts allow-forms allow-modals allow-top-navigation-by-user-activation"
              />
              {iframeFailure ? (
                <div className="absolute inset-0 flex items-center justify-center bg-background/85 p-6 text-center">
                  <div className="max-w-md rounded border border-border bg-background px-4 py-3 text-sm text-muted-foreground">
                    <div>This page can’t be rendered in an iframe.</div>
                    <div className="mt-1">Use “Open externally”.</div>
                  </div>
                </div>
              ) : null}
              {fallbackReason ? (
                <div className="pointer-events-none absolute bottom-3 right-3 rounded border border-border bg-background/90 px-2 py-1 text-[10px] text-muted-foreground">
                  fallback: {fallbackReason}
                </div>
              ) : null}
            </>
          ) : (
            <>
              <div className="h-full w-full bg-white" />
              {electronFailure ? (
                <div className="absolute inset-0 flex items-center justify-center bg-background/85 p-6 text-center">
                  <div className="max-w-xl rounded border border-border bg-background px-4 py-3 text-sm text-muted-foreground">
                    <div>This page failed to load.</div>
                    <div className="mt-1 break-all">{electronFailure}</div>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
      {bookmarksMenuOpen && bookmarksMenuPosition ? (
        <div
          ref={bookmarksMenuRef}
          className="fixed z-[120] w-[320px] rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
          style={{ top: bookmarksMenuPosition.top, left: bookmarksMenuPosition.left }}
        >
          <div className="overflow-auto" style={{ maxHeight: `${bookmarksMenuPosition.maxHeight}px` }}>
            {bookmarksLoading ? (
              <div className="px-2 py-1.5 text-sm text-muted-foreground">Loading...</div>
            ) : allTopLevelNodes.length > 0 ? (
              renderDropdownNodes(allTopLevelNodes)
            ) : (
              <div className="px-2 py-1.5 text-sm text-muted-foreground">No bookmarks</div>
            )}
          </div>
        </div>
      ) : null}
      <Dialog open={managerOpen} onOpenChange={setManagerOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Bookmark manager</DialogTitle>
            <DialogDescription>Manage bookmarks and folders</DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] space-y-2 overflow-auto pr-1">
            {bookmarks ? (
              <>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-muted-foreground">Bookmarks bar</div>
                  {bookmarks.roots.bookmark_bar.children.length > 0 ? (
                    renderManagerNodes(bookmarks.roots.bookmark_bar.children)
                  ) : (
                    <div className="rounded border border-dashed border-border px-2 py-2 text-xs text-muted-foreground">Empty</div>
                  )}
                </div>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-muted-foreground">Other bookmarks</div>
                  {bookmarks.roots.other.children.length > 0 ? (
                    renderManagerNodes(bookmarks.roots.other.children)
                  ) : (
                    <div className="rounded border border-dashed border-border px-2 py-2 text-xs text-muted-foreground">Empty</div>
                  )}
                </div>
              </>
            ) : (
              <div className="rounded border border-dashed border-border px-2 py-2 text-xs text-muted-foreground">
                {bookmarksLoading ? "Loading..." : "No data"}
              </div>
            )}
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1 rounded border border-border px-2 text-xs hover:bg-muted"
              onClick={() => {
                void createFolder();
              }}
            >
              <Plus className="h-3.5 w-3.5" />
              New folder
            </button>
            <button
              type="button"
              className="inline-flex h-8 items-center rounded border border-border px-2 text-xs hover:bg-muted"
              onClick={() => {
                setManagerOpen(false);
              }}
            >
              Done
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
