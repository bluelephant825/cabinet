"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
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
  Loader2,
  Plus,
  RefreshCw,
  Tags,
  Trash2,
  X,
  Bug,
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
import { useTreeStore } from "@/stores/tree-store";
import { openExternalUrl } from "@/lib/runtime/open-url";
import { useDaemonChannel } from "@/hooks/use-daemon-channel";
import {
  activateTab as activateSidecarTabRequest,
  backTab as backSidecarTab,
  closeTab as closeSidecarTab,
  focusWindow as focusSidecarWindow,
  forwardTab as forwardSidecarTab,
  getStatus as getSidecarStatus,
  isSidecarUrl,
  listTabs as listSidecarTabs,
  navigateTab as navigateSidecarTab,
  openTab as openSidecarTab,
  reloadTab as reloadSidecarTab,
  setWindowBounds as setSidecarWindowBounds,
  type SidecarStatus,
  type SidecarTab,
} from "@/lib/browser/sidecar-client";
import {
  getHost,
  type ElectronHostExtras,
  type HostBookmarkMenuItem,
  type HostWindowGeometry,
} from "@/lib/host";

type ThreeJsEditorWindow = Window & {
  __lastImportedFile?: string;
  editor?: {
    clear?: () => void;
    loader?: {
      loadFiles?: (files: File[]) => void;
    };
  };
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
  tags: string[];
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

type BookmarkFolderOption = {
  id: string;
  label: string;
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

function toBridgeBookmarkMenuItems(nodes: BookmarkNode[]): HostBookmarkMenuItem[] {
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

const TAG_CLOUD_DATA_URL_PREFIX = "data:text/html;cabinet-tag-cloud=1;charset=utf-8,";

function isTagCloudDataUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  return value.startsWith(TAG_CLOUD_DATA_URL_PREFIX);
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

type TagBookmarkEntry = {
  name: string;
  url: string;
};

type TagCloudEntry = {
  key: string;
  label: string;
  bookmarks: TagBookmarkEntry[];
};

function collectBookmarkTagEntries(nodes: BookmarkNode[]): TagCloudEntry[] {
  const tagsMap = new Map<string, TagCloudEntry>();
  const walk = (items: BookmarkNode[]) => {
    for (const node of items) {
      if (node.type === "folder") {
        walk(node.children);
        continue;
      }
      const bookmarkName = node.name.trim() || node.url;
      const bookmarkUrl = node.url.trim();
      if (!bookmarkUrl) continue;
      for (const rawTag of node.tags) {
        const label = rawTag.trim();
        if (!label) continue;
        const key = label.toLocaleLowerCase();
        const existing = tagsMap.get(key);
        if (!existing) {
          tagsMap.set(key, {
            key,
            label,
            bookmarks: [{ name: bookmarkName, url: bookmarkUrl }],
          });
          continue;
        }
        const duplicate = existing.bookmarks.some((bookmark) => bookmark.url === bookmarkUrl && bookmark.name === bookmarkName);
        if (!duplicate) {
          existing.bookmarks.push({ name: bookmarkName, url: bookmarkUrl });
        }
      }
    }
  };
  walk(nodes);
  const entries = Array.from(tagsMap.values()).map((entry) => ({
    ...entry,
    bookmarks: [...entry.bookmarks].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
  }));
  return entries.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}

function buildTagCloudHtml(entries: TagCloudEntry[]): string {
  const tagAnchors = entries
    .map((entry) => `  <a class="tag" href="#" data-tag-key="${escapeHtml(entry.key)}">${escapeHtml(entry.label)}</a>`)
    .join("\n");
  const tagsPayload = JSON.stringify(
    entries.map((entry) => ({
      key: entry.key,
      label: entry.label,
      bookmarks: entry.bookmarks,
    }))
  ).replaceAll("</", "<\\/");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Bookmark Tags</title>
<style>
:root {
  --tag-bg-sat: 72%;
  --tag-bg-light: 68%;
  --tag-text: rgba(255,255,255,0.92);
  --tag-shadow:
    0 2px 6px rgba(72, 76, 160, 0.18),
    0 10px 18px rgba(72, 76, 160, 0.08);
  --tag-highlight:
    inset 0 1px 1px rgba(255,255,255,0.45),
    inset 0 -1px 1px rgba(255,255,255,0.08);
  --tag-blur: blur(10px);
  --cloud-bg: #efedf7;
}
body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  padding: 24px;
  background: var(--cloud-bg);
  box-sizing: border-box;
}
.tag-cloud {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  width: min(95%, 1200px);
  padding: 32px;
  border-radius: 28px;
  background:
    radial-gradient(
      circle at top left,
      rgba(248, 238, 255, 0.9),
      rgb(224, 216, 255)
    );
  font-family:
    Inter,
    SF Pro Display,
    system-ui,
    sans-serif;
}
.tag {
  --hue: 240;
  --sat-multiplier: 1;
  --lightness: var(--tag-bg-light);
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 10px 22px;
  border: 2px solid transparent;
  border-radius: 999px;
  color: var(--tag-text);
  text-decoration: none;
  white-space: nowrap;
  font-size: 0.95rem;
  font-weight: 500;
  letter-spacing: 0.01em;
  backdrop-filter: var(--tag-blur);
  background:
    linear-gradient(
      145deg,
      hsla(
        var(--hue),
        calc(var(--tag-bg-sat) * var(--sat-multiplier)),
        calc(var(--lightness) + 6%),
        0.92
      ),
      hsla(
        var(--hue),
        calc(var(--tag-bg-sat) * var(--sat-multiplier)),
        var(--lightness),
        0.95
      )
    );
  box-shadow:
    var(--tag-shadow),
    var(--tag-highlight);
  transition:
    transform 160ms ease,
    box-shadow 160ms ease,
    filter 160ms ease;
}
.tag::before {
  content: "";
  position: absolute;
  inset: 1px;
  border-radius: inherit;
  background:
    linear-gradient(
      to bottom,
      rgba(255,255,255,0.22),
      rgba(255,255,255,0.02)
    );
  pointer-events: none;
}
.tag:hover {
  transform: translateY(-2px);
  filter: saturate(1.08);
  box-shadow:
    0 6px 16px rgba(72, 76, 160, 0.22),
    0 14px 30px rgba(72, 76, 160, 0.14),
    var(--tag-highlight);
}
.tag:nth-child(8n + 1) { --hue: 225; }
.tag:nth-child(8n + 2) { --hue: 232; }
.tag:nth-child(8n + 3) { --hue: 238; }
.tag:nth-child(8n + 4) { --hue: 245; }
.tag:nth-child(8n + 5) { --hue: 252; }
.tag:nth-child(8n + 6) { --hue: 258; }
.tag:nth-child(8n + 7) { --hue: 235; }
.tag:nth-child(8n + 8) { --hue: 248; }
.tag:nth-child(3n) {
  --sat-multiplier: 0.92;
}
.tag:nth-child(5n) {
  --lightness: 72%;
}
.tag:nth-child(7n) {
  --lightness: 64%;
}
.tag[data-weight="high"] {
  font-weight: 600;
  padding-inline: 26px;
  --lightness: 60%;
}
.tag[data-weight="low"] {
  opacity: 0.72;
  --sat-multiplier: 0.72;
}
.tag.is-selected {
  border: 2px solid #6d28d9;
}
.tag-cloud.is-filtering {
  opacity: 0.55;
}
.tag-results {
  margin-top: 16px;
  width: min(95%, 1200px);
  padding: 20px;
  border-radius: 20px;
  background: rgba(255,255,255,0.7);
  backdrop-filter: blur(6px);
  font-family:
    Inter,
    SF Pro Display,
    system-ui,
    sans-serif;
}
.tag-results-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  font-size: 0.95rem;
  color: rgba(50, 54, 110, 0.95);
}
.tag-results-close {
  border: 0;
  border-radius: 999px;
  padding: 8px 14px;
  background: rgba(72, 76, 160, 0.12);
  color: rgba(36, 38, 93, 0.95);
  cursor: pointer;
}
.tag-results-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tag-result-link {
  color: rgba(48, 52, 128, 0.96);
  text-decoration: none;
  font-size: 0.92rem;
  padding: 8px 10px;
  border-radius: 10px;
  background: rgba(255,255,255,0.62);
}
.tag-result-link:hover {
  background: rgba(255,255,255,0.88);
}
.tag-results-empty {
  color: rgba(70, 74, 138, 0.7);
  font-size: 0.9rem;
}
</style>
</head>
<body>
<div class="tag-cloud" id="tagCloud">
${tagAnchors}
</div>
<div class="tag-results" id="tagResults" hidden>
  <div class="tag-results-header">
    <span id="tagResultsTitle"></span>
    <button type="button" id="tagResultsClose" class="tag-results-close">Close</button>
  </div>
  <div id="tagResultsBody" class="tag-results-body"></div>
</div>
<script id="tag-data" type="application/json">${tagsPayload}</script>
<script>
function stringToHue(str) {
  let hash = 0;

  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }

  return 220 + (Math.abs(hash) % 40);
}

const tagsData = (() => {
  const el = document.getElementById("tag-data");
  if (!el) return [];
  try {
    return JSON.parse(el.textContent || "[]");
  } catch {
    return [];
  }
})();

const tagCloud = document.getElementById("tagCloud");
const resultsPanel = document.getElementById("tagResults");
const resultsTitle = document.getElementById("tagResultsTitle");
const resultsBody = document.getElementById("tagResultsBody");
const resultsClose = document.getElementById("tagResultsClose");
let selectedTag = null;

document.querySelectorAll(".tag").forEach((element) => {
  const text = (element.textContent || "").trim();
  element.style.setProperty("--hue", String(stringToHue(text)));
  element.addEventListener("click", (event) => {
    event.preventDefault();
    if (selectedTag) {
      selectedTag.classList.remove("is-selected");
    }
    element.classList.add("is-selected");
    selectedTag = element;
    const tagKey = element.getAttribute("data-tag-key") || "";
    const match = tagsData.find((entry) => String(entry.key || "") === tagKey);
    if (!match) return;
    const bookmarks = Array.isArray(match.bookmarks) ? match.bookmarks : [];
    resultsTitle.textContent = String(match.label || "Tag") + " (" + String(bookmarks.length) + ")";
    resultsBody.innerHTML = "";
    if (bookmarks.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tag-results-empty";
      empty.textContent = "No bookmarks";
      resultsBody.appendChild(empty);
    } else {
      bookmarks.forEach((bookmark) => {
        const link = document.createElement("a");
        link.className = "tag-result-link";
        link.href = String(bookmark.url || "about:blank");
        link.textContent = String(bookmark.name || bookmark.url || "Untitled");
        link.title = String(bookmark.url || "");
        resultsBody.appendChild(link);
      });
    }
    resultsPanel.hidden = false;
    tagCloud.classList.add("is-filtering");
  });
});

resultsClose.addEventListener("click", () => {
  resultsPanel.hidden = true;
  tagCloud.classList.remove("is-filtering");
  if (selectedTag) {
    selectedTag.classList.remove("is-selected");
    selectedTag = null;
  }
});
</script>
</body>
</html>`;
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

function toAddressBarValue(value: string | null | undefined): string {
  const normalized = normalizeSessionUrl(value);
  return isTagCloudDataUrl(normalized) ? "" : normalized;
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
  const host = getHost();
  // The chromium fork hosts the app inside the browser window itself: real
  // tabs are positioned in-window via host.layout, and there is no
  // WebContentsView, geometry feed, or second window to keep in sync.
  const isChromiumHost = host.kind === "chromium";
  // Electron-only extras (WebContentsView surface + window geometry feed),
  // absent on chromium and web; every use below stays behind browserMode or
  // method-presence guards, so the empty partial is never exercised there.
  const bridge: Partial<ElectronHostExtras> = host.electron ?? {};
  const url = useAppStore((s) => s.browseUrl);
  const setAppMode = useAppStore((s) => s.setAppMode);
  const selectedPath = useTreeStore((s) => s.selectedPath);
  const initialSessionRef = useRef<BrowserSessionState>(loadBrowserSessionState());
  const [addressValue, setAddressValue] = useState(toAddressBarValue(url ?? initialSessionRef.current.url ?? ""));
  const [browserMode, setBrowserMode] = useState<"initializing" | "electron" | "iframe">(
    // Only the electron host exposes the WebContentsView surface; on
    // chromium the native engine is the iframe (external pages become real
    // in-window tabs via host.layout) and web was always iframe.
    () => (host.electron ? "initializing" : "iframe"),
  );
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
  const [managerEditDialogOpen, setManagerEditDialogOpen] = useState(false);
  const [managerEditNodeId, setManagerEditNodeId] = useState<string | null>(null);
  const [managerEditNodeType, setManagerEditNodeType] = useState<"url" | "folder">("url");
  const [managerEditTitle, setManagerEditTitle] = useState("");
  const [managerEditUrl, setManagerEditUrl] = useState("");
  const [managerEditTags, setManagerEditTags] = useState("");
  const [managerEditParentId, setManagerEditParentId] = useState("1");
  const [bookmarksBarVisible, setBookmarksBarVisible] = useState(true);
  const [bookmarkDialogOpen, setBookmarkDialogOpen] = useState(false);
  const [bookmarkTitle, setBookmarkTitle] = useState("");
  const [bookmarkUrl, setBookmarkUrl] = useState("");
  const [bookmarkTags, setBookmarkTags] = useState("");
  const [bookmarkParentId, setBookmarkParentId] = useState("1");
  const bookmarkTitleRequestRef = useRef(0);

  // ----- Cabinet Browser sidecar -----
  const [sidecarStatus, setSidecarStatus] = useState<SidecarStatus | null>(null);
  const [sidecarStatusLoaded, setSidecarStatusLoaded] = useState(false);
  const [preferNative, setPreferNative] = useState(false);
  const [sidecarFailedUrl, setSidecarFailedUrl] = useState<string | null>(null);
  const [sidecarTabs, setSidecarTabs] = useState<SidecarTab[]>([]);
  const suppressNextSidecarLoadRef = useRef(false);
  const sidecarPaneRef = useRef<HTMLDivElement | null>(null);
  // The content region inside the sidecar pane, below the in-app tab strip.
  // On the chromium host this is the rect the tab's WebContents is
  // positioned at, so the strip (shell UI) stays uncovered.
  const sidecarContentRef = useRef<HTMLDivElement | null>(null);
  const sidecarStatusRef = useRef<SidecarStatus | null>(null);
  const sidecarTabsRef = useRef<SidecarTab[]>([]);
  // True once listTabs() has completed for the current running session; until
  // then the nav effect must not trust the empty ref and open a duplicate tab.
  const sidecarTabsLoadedRef = useRef(false);
  // Last url we sent openTab() for while the browser was not yet running, so a
  // status flicker cannot fire the lazy launch twice for the same url.
  const pendingSidecarOpenRef = useRef<string | null>(null);
  // Pending "park the sidecar window" timeout from the init effect cleanup.
  // React StrictMode mounts, cleans up, and remounts in dev, and the daemon's
  // macOS hide is applied seconds late — an unparked hide can then land after
  // the remount's visible:true and hide Chromium while the user is browsing.
  // Deferring the park lets a remount cancel it.
  const sidecarParkTimerRef = useRef<number | null>(null);
  const windowGeometryRef = useRef<HostWindowGeometry | null>(null);
  const boundsThrottleRef = useRef<number | null>(null);
  const boundsTrailingRef = useRef(false);
  // True while a shell-drawn overlay (dropdown, dialog, popover) covers part
  // of the content rect — the native tab view paints above shell DOM, so the
  // overlay is hidden until the floating UI clears.
  const overlaySuppressedRef = useRef(false);
  const isDialogOpenRef = useRef(false);
  sidecarStatusRef.current = sidecarStatus;
  sidecarTabsRef.current = sidecarTabs;

  // The floating sidecar window — and its own tab strip as the UI — exists
  // only on the electron host. On web the strip below is the controller,
  // and on chromium the fork hides its native tabstrip for shell-hosted
  // tabs, so the in-app strip is needed there too.
  const isDesktopBridge = host.kind === "electron";
  const activeEngine: "sidecar" | "native" =
    isSidecarUrl(url) &&
    sidecarStatus?.eligible === true &&
    !preferNative &&
    sidecarFailedUrl !== url
      ? "sidecar"
      : "native";
  const activeEngineRef = useRef(activeEngine);
  activeEngineRef.current = activeEngine;

  useEffect(() => {
    if (url == null) return;
    setAddressValue(toAddressBarValue(url));
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

  const resolveCurrentPageTitle = async (currentUrl: string): Promise<string> => {
    if (browserMode === "iframe") {
      try {
        const iframeTitle = iframeRef.current?.contentDocument?.title?.trim();
        if (iframeTitle) return iframeTitle;
      } catch {}
    }
    try {
      const response = await fetch("/api/browser/bookmarks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resolveTitle", url: currentUrl }),
      });
      if (!response.ok) return "";
      const data = (await response.json()) as { title?: string | null };
      return typeof data.title === "string" ? data.title : "";
    } catch {
      return "";
    }
  };

  const openBookmarkDialog = async () => {
    if (!url || url === "about:blank") return;
    const currentUrl = addressValue || url;
    const requestId = bookmarkTitleRequestRef.current + 1;
    bookmarkTitleRequestRef.current = requestId;
    setBookmarkUrl(currentUrl);
    setBookmarkTitle("");
    setBookmarkTags("");
    setBookmarkParentId(bookmarks?.roots.bookmark_bar.id ?? "1");
    setBookmarkDialogOpen(true);
    const nextTitle = await resolveCurrentPageTitle(currentUrl);
    if (bookmarkTitleRequestRef.current !== requestId) return;
    setBookmarkTitle(nextTitle);
  };

  const saveBookmarkFromDialog = async () => {
    const normalizedUrl = normalizeBookmarkUrl(bookmarkUrl);
    const tags = bookmarkTags
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
    const response = await fetch("/api/browser/bookmarks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "addBookmark",
        name: bookmarkTitle,
        url: normalizedUrl,
        parentId: bookmarkParentId,
        tags,
      }),
    });
    if (!response.ok) return;
    const data = (await response.json()) as { bookmarks?: BookmarkFile };
    if (data.bookmarks) setBookmarks(data.bookmarks);
    setBookmarkDialogOpen(false);
  };

  const openManagerEditDialog = (node: BookmarkNode, parentId: string) => {
    setManagerEditNodeId(node.id);
    setManagerEditNodeType(node.type);
    setManagerEditTitle(node.name);
    setManagerEditUrl(node.type === "url" ? node.url : "");
    setManagerEditTags(node.type === "url" ? node.tags.join(", ") : "");
    setManagerEditParentId(parentId);
    setManagerOpen(false);
    setManagerEditDialogOpen(true);
  };

  const saveManagerEditDialog = async () => {
    if (!managerEditNodeId) return;
    const response = await fetch("/api/browser/bookmarks", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: managerEditNodeId,
        name: managerEditTitle,
        ...(managerEditNodeType === "url"
          ? {
              url: normalizeBookmarkUrl(managerEditUrl),
              tags: managerEditTags
                .split(",")
                .map((tag) => tag.trim())
                .filter((tag) => tag.length > 0),
              parentId: managerEditParentId,
            }
          : {}),
      }),
    });
    if (!response.ok) return;
    const data = (await response.json()) as { bookmarks?: BookmarkFile };
    if (data.bookmarks) setBookmarks(data.bookmarks);
    setManagerEditDialogOpen(false);
    setManagerEditNodeId(null);
    setManagerOpen(true);
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
    setAddressValue(toAddressBarValue(node.url));
  };

  const setElectronOverlayVisibility = async (visible: boolean) => {
    if (browserMode !== "electron") return;
    const viewId = viewIdRef.current;
    const setBrowserViewVisible = bridge.setBrowserViewVisible;
    if (!viewId || !setBrowserViewVisible) return;
    try {
      const result = await setBrowserViewVisible(viewId, visible);
      if (visible) {
        updateBoundsRef.current();
      }
      if (visible && !result?.ok) {
        setInitAttempt((value) => value + 1);
      }
    } catch {
      if (visible) {
        setInitAttempt((value) => value + 1);
      }
    }
  };

  const openBookmarksNativeMenu = async () => {
    const trigger = bookmarksTriggerRef.current;
    if (!trigger) return;
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
      setAddressValue(toAddressBarValue(result.url));
    }
  };

  const openTagsCloud = () => {
    const entries = bookmarks
      ? collectBookmarkTagEntries([
          bookmarks.roots.bookmark_bar,
          bookmarks.roots.other,
        ])
      : [];
    const html = buildTagCloudHtml(entries);
    const dataUrl = `${TAG_CLOUD_DATA_URL_PREFIX}${encodeURIComponent(html)}`;
    setAppMode("browse", dataUrl);
    setAddressValue("");
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
    if (activeEngine === "sidecar") {
      const active = sidecarTabsRef.current.find((tab) => tab.active);
      if (active) {
        iframeNavActionRef.current = "back";
        void backSidecarTab(active.id)
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
    }
    const applyAppHistoryBack = () => {
      const nextIndex = iframeHistoryIndexRef.current - 1;
      if (nextIndex < 0) return;
      iframeHistoryIndexRef.current = nextIndex;
      iframeNavActionRef.current = "back";
      setAppMode("browse", iframeHistoryRef.current[nextIndex] || "about:blank");
    };
    if (browserMode === "electron") {
      const viewId = viewIdRef.current;
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
    if (activeEngine === "sidecar") {
      const active = sidecarTabsRef.current.find((tab) => tab.active);
      if (active) {
        iframeNavActionRef.current = "forward";
        void forwardSidecarTab(active.id)
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
    }
    const applyAppHistoryForward = () => {
      const nextIndex = iframeHistoryIndexRef.current + 1;
      if (nextIndex >= iframeHistoryRef.current.length) return;
      iframeHistoryIndexRef.current = nextIndex;
      iframeNavActionRef.current = "forward";
      setAppMode("browse", iframeHistoryRef.current[nextIndex] || "about:blank");
    };
    if (browserMode === "electron") {
      const viewId = viewIdRef.current;
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
    if (activeEngine === "sidecar") {
      const active = sidecarTabsRef.current.find((tab) => tab.active);
      if (active) {
        void reloadSidecarTab(active.id).catch(() => {});
        return;
      }
    }
    const applyReloadFallback = () => {
      setIframeReloadKey((k) => k + 1);
    };
    if (browserMode === "electron") {
      const viewId = viewIdRef.current;
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
    if (sidecarParkTimerRef.current !== null) {
      window.clearTimeout(sidecarParkTimerRef.current);
      sidecarParkTimerRef.current = null;
    }
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

    const failToIframe = () => {
      setBrowserMode("iframe");
    };

    const hasElectronBrowserBridge = () => {
      const bridge: Partial<ElectronHostExtras> = getHost().electron ?? {};
      return !!bridge.createBrowserView && !!bridge.destroyBrowserView;
    };

    const attemptInit = () => {
      if (cancelled) return;
      const bridge: Partial<ElectronHostExtras> = getHost().electron ?? {};
      if (!hasElectronBrowserBridge()) {
        retries += 1;
        if (retries >= maxRetries) {
          failToIframe();
          return;
        }
        retryTimer = window.setTimeout(attemptInit, 100);
        return;
      }
      const createBrowserView = bridge.createBrowserView;
      const destroyBrowserView = bridge.destroyBrowserView;
      const loadBrowserViewUrl = bridge.loadBrowserViewUrl;
      if (!createBrowserView || !destroyBrowserView) {
        failToIframe();
        return;
      }
      void createBrowserView(useAppStore.getState().browseUrl || "about:blank")
        .then((result) => {
          if (cancelled) return;
          if (!result?.ok || !result.viewId) {
            failToIframe();
            return;
          }
          setBrowserMode("electron");
          setElectronFailure(null);
          viewIdRef.current = result.viewId;
          updateBoundsRef.current();
          const activeUrl = useAppStore.getState().browseUrl || "about:blank";
          // Sidecar-eligible URLs are routed by the url effect once the
          // sidecar status is known — skip the initial native load for them.
          if (loadBrowserViewUrl && !isSidecarUrl(activeUrl)) {
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
          if (!cancelled) failToIframe();
        });
    };

    const existing = viewIdRef.current;
    if (existing) {
      const bridge: Partial<ElectronHostExtras> = getHost().electron ?? {};
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
    attemptInit();

    return () => {
      cancelled = true;
      cleanup();
      const host = getHost();
      const bridge: Partial<ElectronHostExtras> = host.electron ?? {};
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
      // Leaving browse mode: hide the browser surface if it is up. On the
      // chromium host the tab content shares this window, so dropping the
      // in-window bounds is enough and no deferred park is needed. On
      // electron the sidecar window park is deferred so a dev StrictMode
      // remount (or an initAttempt re-run) cancels it instead of hiding
      // Chromium mid-browse.
      if (sidecarStatusRef.current?.status === "running") {
        if (host.kind === "chromium") {
          void host.layout.setContentBounds(null).catch(() => {});
        } else {
          sidecarParkTimerRef.current = window.setTimeout(() => {
            sidecarParkTimerRef.current = null;
            if (sidecarStatusRef.current?.status !== "running") return;
            void setSidecarWindowBounds({ visible: false }).catch(() => {});
            // Hiding Chromium needs Automation permission it may not have;
            // raising Cabinet above it is permission-free, so do both.
            void host.windows.focus().catch(() => {});
          }, 400);
        }
      }
    };
  }, [initAttempt]);

  useEffect(() => {
    const bridge: Partial<ElectronHostExtras> = getHost().electron ?? {};
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
    const bridge: Partial<ElectronHostExtras> = getHost().electron ?? {};
    const subscribe = bridge.onBrowserViewNavigateRequest;
    if (!subscribe) return;
    const unsubscribe = subscribe((payload) => {
      const targetUrl = payload?.url;
      if (!targetUrl) return;
      // Navigate the browser view to the requested URL (e.g. extension settings page)
      const viewId = viewIdRef.current;
      if (viewId && bridge.loadBrowserViewUrl) {
        void bridge.loadBrowserViewUrl(viewId, targetUrl);
        setAddressValue(toAddressBarValue(targetUrl));
      } else {
        setAppMode("browse", targetUrl);
        setAddressValue(toAddressBarValue(targetUrl));
      }
    });
    return () => {
      unsubscribe();
    };
  }, [setAppMode]);

  useEffect(() => {
    const bridge: Partial<ElectronHostExtras> = getHost().electron ?? {};
    const subscribe = bridge.onBrowserViewClosed;
    if (!subscribe) return;
    const unsubscribe = subscribe((payload) => {
      const activeViewId = viewIdRef.current;
      if (!activeViewId || payload?.viewId !== activeViewId) return;
      setAppMode("edit");
    });
    return () => {
      unsubscribe();
    };
  }, [setAppMode]);

  const handleAutoImportGlb = async (viewId: string, filePath: string) => {
    const bridge: Partial<ElectronHostExtras> = getHost().electron ?? {};
    if (!bridge.executeBrowserViewJavaScript) return;

    try {
      // 1. Fetch the file content from the local API asset route
      const response = await fetch(`/api/assets/${filePath.split("/").map(encodeURIComponent).join("/")}`);
      if (!response.ok) return;

      const blob = await response.blob();
      
      // 2. Convert the file contents to Base64
      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64Str = reader.result as string;
        const filename = filePath.split("/").pop() || "model.glb";

        // 3. Construct the script to execute inside Three.js editor
        const code = `
          (async () => {
            const checkReady = () => {
              return window.editor && window.editor.loader && typeof window.editor.loader.loadFiles === 'function';
            };

            const run = async () => {
              try {
                // Prevent duplicate imports of the same file
                if (window.__lastImportedFile === ${JSON.stringify(filename)}) {
                  return;
                }
                window.__lastImportedFile = ${JSON.stringify(filename)};

                const base64Data = ${JSON.stringify(base64Str)};
                const response = await fetch(base64Data);
                const blob = await response.blob();
                const file = new File([blob], ${JSON.stringify(filename)}, { type: "model/gltf-binary" });
                
                // Clear existing editor scene first to make it a clean import
                if (typeof window.editor.clear === 'function') {
                  window.editor.clear();
                }

                window.editor.loader.loadFiles([file]);
              } catch (err) {
                console.error("Auto-import failed:", err);
              }
            };

            if (checkReady()) {
              run();
            } else {
              const interval = setInterval(() => {
                if (checkReady()) {
                  clearInterval(interval);
                  run();
                }
              }, 100);
            }
          })();
        `;

        // 4. Inject script into the electron browser view
        await bridge.executeBrowserViewJavaScript!(viewId, code);
      };
      reader.readAsDataURL(blob);
    } catch (err) {
      console.error("Failed to read/encode GLB file for auto-import", err);
    }
  };

  const handleIframeAutoImportGlb = async (iframe: HTMLIFrameElement, filePath: string) => {
    if (!filePath) return;
    try {
      const response = await fetch(`/api/assets/${filePath.split("/").map(encodeURIComponent).join("/")}`);
      if (!response.ok) return;

      const blob = await response.blob();
      const filename = filePath.split("/").pop() || "model.glb";

      const win = iframe.contentWindow as ThreeJsEditorWindow | null;
      if (!win) return;

      const checkReady = () => {
        return typeof win.editor?.loader?.loadFiles === 'function';
      };

      const run = async () => {
        try {
          if (win.__lastImportedFile === filename) {
            return;
          }
          win.__lastImportedFile = filename;

          const file = new File([blob], filename, { type: "model/gltf-binary" });
          
          if (typeof win.editor?.clear === 'function') {
            win.editor.clear();
          }
          win.editor?.loader?.loadFiles?.([file]);
        } catch (err) {
          console.error("Iframe auto-import failed:", err);
        }
      };

      if (checkReady()) {
        run();
      } else {
        const interval = setInterval(() => {
          if (checkReady()) {
            clearInterval(interval);
            run();
          }
        }, 100);
      }
    } catch (err) {
      console.error("Failed to read/encode GLB file for iframe auto-import", err);
    }
  };

  /**
   * Session-history bookkeeping shared by the Electron WebContentsView
   * navigation events and the sidecar's browser:tab echoes. Records the URL
   * in the app-level history (consuming any pending back/forward action),
   * persists it, and mirrors it into the address bar. Callers decide whether
   * to also push the URL into the app store.
   */
  const recordNavigation = (nextUrl: string) => {
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
      setAddressValue(toAddressBarValue(nextUrl));
      return;
    }
    if (currentIndex >= 0 && history[currentIndex] === nextUrl) {
      persistBrowserSessionState({ history, index: currentIndex, url: nextUrl });
      setAddressValue(toAddressBarValue(nextUrl));
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
    setAddressValue(toAddressBarValue(nextUrl));
  };

  useEffect(() => {
    const bridge: Partial<ElectronHostExtras> = getHost().electron ?? {};
    const subscribe = bridge.onBrowserViewNavigated;
    if (!subscribe) return;
    const unsubscribe = subscribe((payload) => {
      const activeViewId = viewIdRef.current;
      if (!activeViewId || payload?.viewId !== activeViewId) return;
      const nextUrl = normalizeSessionUrl(payload?.url || "about:blank");

      // Auto-import GLB/GLTF model if loading Three.js editor
      if (nextUrl.includes("/threejs-editor/") && selectedPath && (selectedPath.toLowerCase().endsWith(".glb") || selectedPath.toLowerCase().endsWith(".gltf"))) {
        handleAutoImportGlb(activeViewId, selectedPath);
      }

      recordNavigation(nextUrl);
      if (useAppStore.getState().browseUrl !== nextUrl) {
        suppressNextElectronLoadRef.current = true;
        setAppMode("browse", nextUrl);
      }
    });
    return () => {
      unsubscribe();
    };
  }, [setAppMode, selectedPath]);

  // Load model when selectedPath changes while Three.js editor is active
  useEffect(() => {
    const is3dModel = selectedPath && (selectedPath.toLowerCase().endsWith(".glb") || selectedPath.toLowerCase().endsWith(".gltf"));
    if (!is3dModel || !url?.includes("/threejs-editor/")) return;

    if (browserMode === "electron") {
      const activeViewId = viewIdRef.current;
      if (activeViewId) {
        handleAutoImportGlb(activeViewId, selectedPath);
      }
    } else if (browserMode === "iframe") {
      const iframe = iframeRef.current;
      if (iframe) {
        handleIframeAutoImportGlb(iframe, selectedPath);
      }
    }
  }, [selectedPath, url, browserMode]);

  // ----- Cabinet Browser sidecar wiring -----
  // Status comes from GET /api/browser/status once and then the "browser"
  // daemon channel; tab echoes keep the address bar, history and app-mode URL
  // in sync with what the user does inside the Chromium window.

  const refreshSidecarTabs = useCallback(() => {
    if (sidecarStatusRef.current?.status !== "running") return;
    void listSidecarTabs()
      .then(setSidecarTabs)
      .catch(() => {});
  }, []);

  const syncActiveSidecarTab = (tabUrl: string) => {
    if (activeEngineRef.current !== "sidecar") return;
    const normalized = normalizeSessionUrl(tabUrl);
    recordNavigation(normalized);
    if (
      isSidecarUrl(normalized) &&
      useAppStore.getState().browseUrl !== normalized
    ) {
      suppressNextSidecarLoadRef.current = true;
      setAppMode("browse", normalized);
    }
  };

  const handleBrowserEventRef = useRef<(data: Record<string, unknown>) => void>(() => {});
  handleBrowserEventRef.current = (data) => {
    const type = typeof data.type === "string" ? data.type : "";
    if (type === "browser:status") {
      // Refetch rather than patching: the event carries only the status name,
      // so error text / eligible would go stale.
      void getSidecarStatus()
        .then((s) => {
          setSidecarStatus(s);
          setSidecarStatusLoaded(true);
        })
        .catch(() => setSidecarStatusLoaded(true));
      return;
    }
    if (type === "browser:download") {
      const downloadedBytes = Number(data.downloadedBytes) || 0;
      const totalBytes = Number(data.totalBytes) || 0;
      setSidecarStatus((prev) =>
        prev
          ? { ...prev, status: "downloading", download: { downloadedBytes, totalBytes } }
          : prev,
      );
      return;
    }
    if (type === "browser:tab") {
      const tab = data.tab as SidecarTab | undefined;
      if (tab?.active && typeof tab.url === "string" && tab.url) {
        syncActiveSidecarTab(tab.url);
      }
      refreshSidecarTabs();
    }
  };
  const browserChannelHandler = useCallback(
    (data: Record<string, unknown>) => handleBrowserEventRef.current(data),
    [],
  );
  useDaemonChannel("browser", browserChannelHandler);

  useEffect(() => {
    let cancelled = false;
    void getSidecarStatus()
      .then((status) => {
        if (cancelled) return;
        setSidecarStatus(status);
        setSidecarStatusLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setSidecarStatusLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Refresh the tab list whenever the sidecar (re)enters running state.
  useEffect(() => {
    if (sidecarStatus?.status !== "running") {
      setSidecarTabs([]);
      sidecarTabsLoadedRef.current = false;
      return;
    }
    let cancelled = false;
    void listSidecarTabs()
      .then((tabs) => {
        if (cancelled) return;
        setSidecarTabs(tabs);
        sidecarTabsLoadedRef.current = true;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sidecarStatus?.status]);

  // Sidecar navigation: the app-store URL is the intent; in sidecar mode we
  // drive the active Chromium tab (or open one, which lazily downloads and
  // launches the browser) instead of loading into the WebContentsView/iframe.
  useEffect(() => {
    if (activeEngine !== "sidecar" || !url) return;
    if (suppressNextSidecarLoadRef.current) {
      suppressNextSidecarLoadRef.current = false;
      return;
    }
    let cancelled = false;
    void (async () => {
      // The pane can mount while Chromium is already running but before the
      // tab list has been fetched: fetch it first or we open a duplicate tab.
      if (
        sidecarStatusRef.current?.status === "running" &&
        !sidecarTabsLoadedRef.current
      ) {
        try {
          const tabs = await listSidecarTabs();
          if (cancelled) return;
          setSidecarTabs(tabs);
          sidecarTabsLoadedRef.current = true;
        } catch {
          // Fall through and open: a transient list failure should not block.
        }
      }
      if (cancelled) return;
      const active = sidecarTabsRef.current.find((tab) => tab.active);
      if (active) {
        if (active.url !== url) {
          void navigateSidecarTab(active.id, url).catch(() => {});
        }
      } else {
        if (pendingSidecarOpenRef.current === url) return;
        pendingSidecarOpenRef.current = url;
        void openSidecarTab(url)
          .catch(() => {})
          .finally(() => {
            if (pendingSidecarOpenRef.current === url) {
              pendingSidecarOpenRef.current = null;
            }
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url, activeEngine]);

  // Sidecar failure: toast once per URL and fall back to the native engine.
  useEffect(() => {
    if (
      sidecarStatus?.status === "error" &&
      sidecarStatus.eligible &&
      isSidecarUrl(url) &&
      !preferNative &&
      sidecarFailedUrl !== url
    ) {
      window.dispatchEvent(
        new CustomEvent("cabinet:toast", {
          detail: {
            kind: "error",
            message: sidecarStatus.error || "Cabinet Browser failed to start",
          },
        }),
      );
      setSidecarFailedUrl(url ?? null);
    }
  }, [sidecarStatus, url, preferNative, sidecarFailedUrl]);

  // Leaving sidecar for a native URL: park the browser surface but keep the
  // engine alive so the next external page restores instantly. On electron
  // that means hiding the floating Chromium window; on the chromium host
  // the tab shares this window, so it is a single in-window layout call.
  const prevEngineRef = useRef<"sidecar" | "native">(activeEngine);
  useEffect(() => {
    const prev = prevEngineRef.current;
    prevEngineRef.current = activeEngine;
    if (
      prev === "sidecar" &&
      activeEngine === "native" &&
      sidecarStatusRef.current?.status === "running"
    ) {
      const host = getHost();
      if (host.kind === "chromium") {
        void host.layout.setContentBounds(null).catch(() => {});
      } else {
        void setSidecarWindowBounds({ visible: false }).catch(() => {});
        void host.windows.focus().catch(() => {});
      }
    }
  }, [activeEngine]);

  // Bounds sync. On the chromium host the app IS the browser window: the
  // fork positions the active tab's WebContents at the pane's
  // viewport-relative CSS-px rect via host.layout.setContentBounds — no
  // second window, no geometry IPC, no hide/focus dance. On electron the
  // separate Chromium window floats over the pane, so every pane rect
  // change and window move/resize is forwarded in screen coordinates. Blur
  // never hides the window — blur is exactly what happens when the user
  // clicks into Chromium.
  useEffect(() => {
    const host = getHost();
    if (activeEngine !== "sidecar") return;

    if (host.kind === "chromium") {
      // The P1 extension host injects window.cabinetHost but cannot position
      // tab content (Chrome owns the window chrome), so capabilities.layout
      // is false there — no bounds traffic, the pane renders a pointer
      // surface instead.
      if (!host.capabilities.layout) return;

      const paneEl = () =>
        sidecarContentRef.current ?? sidecarPaneRef.current ?? containerRef.current;

      // Detect shell-drawn floating UI (dropdowns, dialogs, popovers)
      // intersecting the content rect: the overlay is a native sibling
      // invisible to DOM hit-testing and always paints above the shell, so
      // while such UI is open we report null bounds and hide it instead.
      // The Electron build got this for free — clicking a shell control
      // raised Cabinet's window above the separate Chromium window.
      const OVERLAY_SELECTOR =
        '[role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"], ' +
        '[data-radix-popper-content-wrapper], [class*="z-"]';
      const paneIsCovered = () => {
        const pane = paneEl();
        if (!pane) return false;
        const rect = pane.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) return false;
        // Overlay-ish elements (Radix portals, custom z-indexed menus) whose
        // rect intersects the content area — catches even a few px of
        // overhang that point sampling would miss.
        for (const el of document.querySelectorAll(OVERLAY_SELECTOR)) {
          if (pane.contains(el)) continue;
          const style = getComputedStyle(el);
          if (style.position !== "fixed" && style.position !== "absolute") continue;
          if (style.display === "none" || style.visibility === "hidden") continue;
          const r = el.getBoundingClientRect();
          if (r.width < 4 || r.height < 4) continue;
          if (
            r.left < rect.right && r.right > rect.left &&
            r.top < rect.bottom && r.bottom > rect.top
          ) return true;
        }
        // Point-grid fallback for floating UI without recognizable markup:
        // elementsFromPoint only sees shell DOM, so a topmost element outside
        // the pane means something is covering that spot.
        for (let ix = 1; ix <= 7; ix += 1) {
          for (let iy = 1; iy <= 5; iy += 1) {
            const top = document.elementsFromPoint(
              rect.left + (rect.width * ix) / 8,
              rect.top + (rect.height * iy) / 6,
            )[0];
            if (top && top !== pane && !pane.contains(top)) return true;
          }
        }
        return false;
      };

      const sendBounds = () => {
        if (sidecarStatusRef.current?.status !== "running") return;
        if (overlaySuppressedRef.current) {
          void host.layout.setContentBounds(null).catch(() => {});
          return;
        }
        const pane = paneEl();
        if (!pane) return;
        const rect = pane.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) return;
        void host.layout
          .setContentBounds({
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          })
          .catch(() => {});
      };

      const syncSuppression = () => {
        const covered = paneIsCovered();
        if (covered === overlaySuppressedRef.current) return;
        overlaySuppressedRef.current = covered;
        sendBounds();
      };

      const scheduleSendBounds = () => {
        if (boundsThrottleRef.current !== null) {
          boundsTrailingRef.current = true;
          return;
        }
        sendBounds();
        boundsThrottleRef.current = window.setTimeout(() => {
          boundsThrottleRef.current = null;
          if (boundsTrailingRef.current) {
            boundsTrailingRef.current = false;
            scheduleSendBounds();
          }
        }, 50);
      };

      const pane =
        sidecarContentRef.current ?? sidecarPaneRef.current ?? containerRef.current;
      const observer = new ResizeObserver(scheduleSendBounds);
      if (pane) observer.observe(pane);
      scheduleSendBounds();

      // Re-evaluate coverage on DOM changes (menus/dialogs mount via portals)
      // and on a slow poll to catch open/enter animations.
      let suppressionCheckQueued = false;
      const scheduleSuppressionCheck = () => {
        if (suppressionCheckQueued) return;
        suppressionCheckQueued = true;
        requestAnimationFrame(() => {
          suppressionCheckQueued = false;
          syncSuppression();
        });
      };
      const domObserver = new MutationObserver(scheduleSuppressionCheck);
      domObserver.observe(document.body, { childList: true, subtree: true });
      const suppressionPoll = window.setInterval(syncSuppression, 400);
      syncSuppression();

      return () => {
        observer.disconnect();
        domObserver.disconnect();
        window.clearInterval(suppressionPoll);
        overlaySuppressedRef.current = false;
        if (boundsThrottleRef.current !== null) {
          window.clearTimeout(boundsThrottleRef.current);
          boundsThrottleRef.current = null;
        }
        boundsTrailingRef.current = false;
        // Leaving the sidecar engine (or unmounting): drop the in-window
        // content bounds immediately.
        void host.layout.setContentBounds(null).catch(() => {});
      };
    }

    const bridge: Partial<ElectronHostExtras> = host.electron ?? {};
    if (typeof bridge.getWindowGeometry !== "function" || typeof bridge.onWindowGeometryChanged !== "function") {
      return;
    }

    const sendBounds = () => {
      if (sidecarStatusRef.current?.status !== "running") return;
      const geometry = windowGeometryRef.current;
      const pane = sidecarPaneRef.current ?? containerRef.current;
      if (!geometry?.contentBounds || !pane) return;
      const rect = pane.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return;
      const visible =
        !geometry.minimized &&
        geometry.visible !== false &&
        activeEngineRef.current === "sidecar";
      void setSidecarWindowBounds({
        x: Math.round(geometry.contentBounds.x + rect.left),
        y: Math.round(geometry.contentBounds.y + rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        visible,
      }).catch(() => {});
    };

    const scheduleSendBounds = () => {
      if (boundsThrottleRef.current !== null) {
        boundsTrailingRef.current = true;
        return;
      }
      sendBounds();
      boundsThrottleRef.current = window.setTimeout(() => {
        boundsThrottleRef.current = null;
        if (boundsTrailingRef.current) {
          boundsTrailingRef.current = false;
          scheduleSendBounds();
        }
      }, 50);
    };

    let focusTimer: number | null = null;
    const unsubscribeGeometry = bridge.onWindowGeometryChanged((payload) => {
      windowGeometryRef.current = payload ?? null;
      scheduleSendBounds();
      // Focus protocol: when Cabinet regains focus while the sidecar is up,
      // hand focus back to Chromium unless the user is typing in Cabinet or a
      // dialog is open.
      if (
        payload?.focused &&
        sidecarStatusRef.current?.status === "running" &&
        activeEngineRef.current === "sidecar"
      ) {
        if (focusTimer !== null) window.clearTimeout(focusTimer);
        focusTimer = window.setTimeout(() => {
          focusTimer = null;
          if (activeEngineRef.current !== "sidecar") return;
          const active = document.activeElement;
          const editing =
            active instanceof HTMLElement &&
            (active.tagName === "INPUT" ||
              active.tagName === "TEXTAREA" ||
              active.isContentEditable);
          if (!editing && !isDialogOpenRef.current) {
            void focusSidecarWindow().catch(() => {});
          }
        }, 150);
      }
    });
    void bridge
      .getWindowGeometry()
      .then((geometry) => {
        windowGeometryRef.current = geometry ?? null;
        scheduleSendBounds();
      })
      .catch(() => {});

    const pane = sidecarPaneRef.current ?? containerRef.current;
    const observer = new ResizeObserver(scheduleSendBounds);
    if (pane) observer.observe(pane);
    scheduleSendBounds();

    return () => {
      unsubscribeGeometry();
      observer.disconnect();
      if (focusTimer !== null) window.clearTimeout(focusTimer);
      if (boundsThrottleRef.current !== null) {
        window.clearTimeout(boundsThrottleRef.current);
        boundsThrottleRef.current = null;
      }
      boundsTrailingRef.current = false;
    };
  }, [activeEngine, sidecarStatus?.status]);

  const focusSidecar = () => {
    if (isChromiumHost) {
      // Fork: tab content shares this window, nothing to raise.
      // P1 extension host: "focus" means activating the real Chrome tab
      // this page opened in.
      if (host.capabilities.layout) return;
      const match =
        sidecarTabsRef.current.find((tab) => tab.url === url) ??
        sidecarTabsRef.current.find((tab) => tab.active);
      if (match) void activateSidecarTabRequest(match.id).catch(() => {});
      return;
    }
    if (sidecarStatusRef.current?.status !== "running") return;
    void focusSidecarWindow().catch(() => {});
  };

  const selectSidecarTab = (tab: SidecarTab) => {
    if (sidecarStatusRef.current?.status !== "running") return;
    setSidecarTabs((prev) => prev.map((entry) => ({ ...entry, active: entry.id === tab.id })));
    void activateSidecarTabRequest(tab.id).catch(() => {});
    if (
      isSidecarUrl(tab.url) &&
      useAppStore.getState().browseUrl !== tab.url
    ) {
      suppressNextSidecarLoadRef.current = true;
      setAppMode("browse", tab.url);
    }
    setAddressValue(toAddressBarValue(tab.url));
    focusSidecar();
  };

  useEffect(() => {
    const bridge: Partial<ElectronHostExtras> = getHost().electron ?? {};
    const viewId = viewIdRef.current;
    if (!bridge.createBrowserView || !bridge.destroyBrowserView || !viewId || browserMode !== "electron") {
      return;
    }
    // External URLs belong to the sidecar once its status is known; until
    // then, hold off on loading them into the WebContentsView so a potentially
    // eligible URL does not flash in the fallback view first.
    if (activeEngine === "sidecar") return;
    if (isSidecarUrl(url) && !sidecarStatusLoaded) return;
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
  }, [url, browserMode, activeEngine, sidecarStatusLoaded]);

  useEffect(() => {
    const bridge: Partial<ElectronHostExtras> = getHost().electron ?? {};
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

  // In Electron browse mode, the native WebContentsView sits above all DOM
  // content — CSS z-index can't raise toasts above it. Intercept toast events
  // and forward them to the Electron main process, which renders a native
  // Menu.popup() above the BrowserView (same pattern as the extensions menu).
  useEffect(() => {
    if (browserMode !== "electron") return;
    const host = getHost();
    // host.system.showToast falls back to re-dispatching "cabinet:toast"
    // when a shell has no native toast surface; the flag lets that
    // re-dispatched event through instead of intercepting it forever.
    let forwarding = false;
    const handler = (event: Event) => {
      if (forwarding) return;
      const detail = (event as CustomEvent).detail as
        | { kind?: string; message?: string; durationMs?: number }
        | undefined;
      if (!detail?.message) return;
      event.preventDefault();
      forwarding = true;
      try {
        void host.system.showToast({
          kind: detail.kind,
          message: detail.message,
          durationMs: detail.durationMs,
        });
      } finally {
        forwarding = false;
      }
    };
    window.addEventListener("cabinet:toast", handler);
    return () => window.removeEventListener("cabinet:toast", handler);
  }, [browserMode]);

  const isDialogOpen = managerOpen || bookmarkDialogOpen || managerEditDialogOpen;
  isDialogOpenRef.current = isDialogOpen;

  useEffect(() => {
    const bridge: Partial<ElectronHostExtras> = getHost().electron ?? {};
    const viewId = viewIdRef.current;
    if (!bridge.createBrowserView || !bridge.destroyBrowserView || !viewId || browserMode !== "electron") {
      return;
    }
    const setBrowserViewVisible = bridge.setBrowserViewVisible;
    if (!setBrowserViewVisible) return;
    const shouldShow = !isDialogOpen && activeEngine === "native";
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
  }, [browserMode, isDialogOpen, activeEngine]);

  useEffect(() => {
    if (browserMode !== "iframe") {
      setIframePolicyBlocked(false);
      return;
    }
    if (!url || url === "about:blank") {
      setIframePolicyBlocked(false);
      return;
    }
    const isInternalRoute = url.startsWith("/") || (typeof window !== "undefined" && url.startsWith(window.location.origin));
    // Frame-policy checks only apply to real http(s) pages — internal routes,
    // data: (the bookmark tag cloud), file:, about:blank etc. can't carry
    // XFO/CSP headers, and the endpoint 400s on them anyway.
    if (isInternalRoute || !/^https?:/i.test(url)) {
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
        if (!res.ok) {
          if (!cancelled) setIframePolicyBlocked(false);
          return;
        }
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
    const isInternalRoute = url.startsWith("/") || (typeof window !== "undefined" && url.startsWith(window.location.origin));
    // Same gate as the frame-check: data:/file:/about: documents have no
    // headers to inspect and their cross-origin DOM can't be probed, so the
    // failure heuristic would only produce false positives.
    if (isInternalRoute || !/^https?:/i.test(url)) {
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

  const bookmarkFolderOptions: BookmarkFolderOption[] = (() => {
    if (!bookmarks) return [];
    const options: BookmarkFolderOption[] = [];
    const pushFolderOptions = (nodes: BookmarkNode[], parentLabel: string) => {
      for (const node of normalizeBookmarkNodes(nodes)) {
        if (node.type !== "folder") continue;
        const label = `${parentLabel} / ${node.name}`;
        options.push({ id: node.id, label });
        pushFolderOptions(node.children, label);
      }
    };
    options.push({ id: bookmarks.roots.bookmark_bar.id, label: bookmarks.roots.bookmark_bar.name });
    pushFolderOptions(bookmarks.roots.bookmark_bar.children, bookmarks.roots.bookmark_bar.name);
    options.push({ id: bookmarks.roots.other.id, label: bookmarks.roots.other.name });
    pushFolderOptions(bookmarks.roots.other.children, bookmarks.roots.other.name);
    return options;
  })();

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

  const renderManagerNodes = (nodes: BookmarkNode[], parentId: string, depth = 0): ReactNode => {
    return normalizeBookmarkNodes(nodes).map((node) => {
      return (
        <div key={node.id} className="space-y-1">
          <div className="flex items-center gap-2 rounded border border-border/70 px-2 py-1">
            <div style={{ marginLeft: `${depth * 14}px` }} className="flex items-center gap-1.5 min-w-0 flex-1">
              <span className="truncate text-xs text-foreground">{node.name}</span>
            </div>
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded border border-border hover:bg-muted"
              onClick={() => {
                openManagerEditDialog(node, parentId);
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
              title="Delete"
              aria-label="Delete"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          {node.type === "folder" && node.children.length > 0 ? renderManagerNodes(node.children, node.id, depth + 1) : null}
        </div>
      );
    });
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <Header />
      <div className="flex flex-1 min-h-0 flex-col overflow-hidden bg-(--gutter)">
        <div className="grid grid-cols-[1fr_minmax(0,720px)_1fr] items-center gap-3 border-b border-border/70 bg-[#F1E4D3] px-4 py-2 text-sm text-muted-foreground">
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
            {browserMode === "electron" && activeEngine === "native" && (
              <button
                type="button"
                onClick={() => {
                  const viewId = viewIdRef.current;
                  if (viewId && bridge.openBrowserViewDevTools) {
                    void bridge.openBrowserViewDevTools(viewId);
                  }
                }}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-transparent text-foreground hover:border-border hover:bg-muted"
                aria-label="Toggle DevTools"
                title="Toggle DevTools — inspect the browser page and see content script errors"
              >
                <Bug className="h-3.5 w-3.5" />
              </button>
            )}
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
                // Consume any pending echo suppression so a queued tab echo
                // cannot swallow this explicit navigation.
                suppressNextElectronLoadRef.current = false;
                suppressNextSidecarLoadRef.current = false;
                setAppMode("browse", nextUrl);
                setAddressValue(toAddressBarValue(nextUrl));
                if (activeEngine === "sidecar") {
                  focusSidecar();
                }
              }}
              placeholder={t("editor:browser.noUrl")}
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground shadow-sm outline-none ring-offset-background focus:ring-2 focus:ring-ring"
            />
              <button
                type="button"
                onClick={openBookmarkDialog}
                className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-transparent text-foreground hover:border-border hover:bg-muted"
                title="Save bookmark"
                aria-label="Save bookmark"
              >
              <Bookmark className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                void setElectronOverlayVisibility(false).then(() => {
                  setManagerOpen(true);
                });
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
            <button
              type="button"
              onClick={openTagsCloud}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-transparent text-foreground hover:border-border hover:bg-muted"
              title="Tags"
              aria-label="Tags"
            >
              <Tags className="h-4 w-4" />
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
          <div className="border-b border-border/70 bg-[#F1E4D3] px-4 py-1.5">
            <div className="flex items-center gap-1.5 overflow-x-auto">
              {bookmarkBarNodes.length > 0 ? (
                bookmarkBarNodes.map((node) => (
                  <button
                    key={node.id}
                    type="button"
                    onClick={() => {
                      void openBookmarkUrl(node);
                    }}
                    className="inline-flex h-7 max-w-55 shrink-0 items-center rounded-md border border-transparent px-2 text-xs text-foreground hover:border-border hover:bg-muted"
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
        <div
          ref={containerRef}
          className="relative flex-1 min-h-0 rounded-[20px] overflow-hidden bg-background"
          style={{
            transform: "translate3d(0, 0, 0)",
            clipPath: "inset(0% 0% 0% 0% round 20px)",
            isolation: "isolate",
          }}
        >
          {activeEngine === "sidecar" ? (
            <div
              ref={sidecarPaneRef}
              className="flex h-full w-full flex-col bg-background"
              onClick={focusSidecar}
            >
              {/* On electron the real Chromium window covers this pane and its
                  own tab strip is the UI. This strip is the controller on web
                  (free-floating window) and on the chromium fork, which hides
                  its native tabstrip for shell-hosted tabs. */}
              {!isDesktopBridge && (
              <div className="flex items-center gap-1 overflow-x-auto border-b border-border/70 bg-muted/40 px-2 py-1">
                {sidecarTabs.map((tab) => (
                  <div
                    key={tab.id}
                    className={`group flex max-w-48 shrink-0 items-center rounded-md border text-xs ${
                      tab.active
                        ? "border-border bg-background text-foreground"
                        : "border-transparent text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        selectSidecarTab(tab);
                      }}
                      className="min-w-0 truncate px-2 py-1.5"
                      title={tab.url}
                    >
                      {tab.title || tab.url || "New tab"}
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        void closeSidecarTab(tab.id).catch(() => {});
                      }}
                      className="mr-1 hidden h-4 w-4 items-center justify-center rounded hover:bg-foreground/10 group-hover:inline-flex"
                      aria-label="Close tab"
                      title="Close tab"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    void openSidecarTab("about:blank").catch(() => {});
                  }}
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
                  aria-label="New tab"
                  title="New tab"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>
              )}
              <div
                ref={sidecarContentRef}
                className="flex flex-1 items-center justify-center p-6 text-center"
              >
                {sidecarStatus?.status === "downloading" ? (
                  <div className="text-sm text-muted-foreground">
                    Downloading Cabinet Browser…
                    {sidecarStatus.download && sidecarStatus.download.totalBytes > 0
                      ? ` ${(sidecarStatus.download.downloadedBytes / 1048576).toFixed(0)} / ${(sidecarStatus.download.totalBytes / 1048576).toFixed(0)} MB`
                      : ""}
                  </div>
                ) : sidecarStatus?.status === "running" ? (
                  isChromiumHost ? (
                    host.capabilities.layout ? (
                      // The fork draws the active tab's WebContents into this
                      // region, so the DOM underneath only needs a quiet
                      // surface while the page arrives. No separate-window
                      // copy: there is no second window to point at.
                      <div className="flex items-center gap-2 text-sm text-muted-foreground/70">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading page…
                      </div>
                    ) : (
                      // P1 extension host: the page is a real Chrome tab in
                      // this window's own tab strip, not content this app
                      // can position. Offer a jump back to it.
                      <div className="space-y-3">
                        <div className="text-sm text-muted-foreground">
                          This page is open in a browser tab
                        </div>
                        <div className="flex items-center justify-center">
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              focusSidecar();
                            }}
                            className="inline-flex h-8 items-center rounded-md border border-border px-3 text-xs text-foreground hover:bg-muted"
                          >
                            Show tab
                          </button>
                        </div>
                      </div>
                    )
                  ) : (
                  <div className="space-y-3">
                    <div className="text-sm text-muted-foreground">
                      {isDesktopBridge
                        ? "The page is shown in the Cabinet Browser window"
                        : "The Cabinet Browser is open in a separate window"}
                    </div>
                    <div className="flex items-center justify-center gap-4">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          focusSidecar();
                        }}
                        className="inline-flex h-8 items-center rounded-md border border-border px-3 text-xs text-foreground hover:bg-muted"
                      >
                        Show browser
                      </button>
                      {isDesktopBridge ? (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setPreferNative(true);
                          }}
                          className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                        >
                          Use built-in view
                        </button>
                      ) : null}
                    </div>
                  </div>
                  )
                ) : (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Starting Cabinet Browser…
                  </div>
                )}
              </div>
            </div>
          ) : browserMode === "iframe" ? (
            <>
              <iframe
                key={`${url || "about:blank"}:${iframeReloadKey}`}
                ref={iframeRef}
                title={t("editor:browser.openExternally")}
                src={url || "about:blank"}
                onLoad={() => {
                  iframeLoadedTokenRef.current = iframeLoadTokenRef.current;
                  setIframeLoadedToken(iframeLoadTokenRef.current);

                  // Same-origin auto-import fallback for web browsers
                  const iframe = iframeRef.current;
                  const is3dModel = selectedPath && (selectedPath.toLowerCase().endsWith(".glb") || selectedPath.toLowerCase().endsWith(".gltf"));
                  if (iframe && is3dModel && url?.includes("/threejs-editor/")) {
                    handleIframeAutoImportGlb(iframe, selectedPath);
                  }
                }}
                className="h-full w-full border-0 bg-transparent"
                style={{
                  clipPath: "inset(0% 0% 0% 0% round 20px)",
                  borderRadius: "20px",
                  overflow: "hidden",
                }}
                sandbox="allow-same-origin allow-scripts allow-forms allow-modals allow-downloads allow-top-navigation-by-user-activation"
              />
              {iframeFailure ? (
                <div className="absolute inset-0 flex items-center justify-center bg-background/85 p-6 text-center">
                  <div className="max-w-md rounded border border-border bg-background px-4 py-3 text-sm text-muted-foreground">
                    <div>This page can’t be rendered in an iframe.</div>
                    {url ? (
                      <button
                        type="button"
                        onClick={() => openExternalUrl(url)}
                        className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-muted transition-colors"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        Open in new tab
                      </button>
                    ) : (
                      <div className="mt-1">Use “Open externally”.</div>
                    )}
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <>
              <div className="h-full w-full bg-transparent" />
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
          className="fixed z-120 w-[320px] rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
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
      <Dialog open={bookmarkDialogOpen} onOpenChange={setBookmarkDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Bookmark</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">Title</div>
              <input
                value={bookmarkTitle}
                onChange={(event) => setBookmarkTitle(event.target.value)}
                className="h-9 w-full rounded border border-border bg-background px-3 text-sm text-foreground"
              />
            </div>
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">URL</div>
              <input
                value={bookmarkUrl}
                onChange={(event) => setBookmarkUrl(event.target.value)}
                className="h-9 w-full rounded border border-border bg-background px-3 text-sm text-foreground"
              />
            </div>
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">Tags</div>
              <input
                value={bookmarkTags}
                onChange={(event) => setBookmarkTags(event.target.value)}
                placeholder="tag1, tag2"
                className="h-9 w-full rounded border border-border bg-background px-3 text-sm text-foreground"
              />
            </div>
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">Folder</div>
              <select
                value={bookmarkParentId}
                onChange={(event) => setBookmarkParentId(event.target.value)}
                className="h-9 w-full rounded border border-border bg-background px-3 text-sm text-foreground"
              >
                {bookmarkFolderOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <button
              type="button"
              className="inline-flex h-8 items-center rounded border border-border px-2 text-xs hover:bg-muted"
              onClick={() => {
                setBookmarkDialogOpen(false);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="inline-flex h-8 items-center rounded border border-border px-2 text-xs hover:bg-muted"
              onClick={() => {
                void saveBookmarkFromDialog();
              }}
            >
              Save
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={managerEditDialogOpen} onOpenChange={(open) => {
        setManagerEditDialogOpen(open);
        if (!open) {
          setManagerEditNodeId(null);
          setManagerOpen(true);
        }
      }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit bookmark</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">Title</div>
              <input
                value={managerEditTitle}
                onChange={(event) => setManagerEditTitle(event.target.value)}
                className="h-9 w-full rounded border border-border bg-background px-3 text-sm text-foreground"
              />
            </div>
            {managerEditNodeType === "url" ? (
              <>
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">URL</div>
                  <input
                    value={managerEditUrl}
                    onChange={(event) => setManagerEditUrl(event.target.value)}
                    className="h-9 w-full rounded border border-border bg-background px-3 text-sm text-foreground"
                  />
                </div>
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">Tags</div>
                  <input
                    value={managerEditTags}
                    onChange={(event) => setManagerEditTags(event.target.value)}
                    placeholder="tag1, tag2"
                    className="h-9 w-full rounded border border-border bg-background px-3 text-sm text-foreground"
                  />
                </div>
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">Folder</div>
                  <select
                    value={managerEditParentId}
                    onChange={(event) => setManagerEditParentId(event.target.value)}
                    className="h-9 w-full rounded border border-border bg-background px-3 text-sm text-foreground"
                  >
                    {bookmarkFolderOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            ) : null}
          </div>
          <DialogFooter className="gap-2">
            <button
              type="button"
              className="inline-flex h-8 items-center rounded border border-border px-2 text-xs hover:bg-muted"
              onClick={() => {
                setManagerEditDialogOpen(false);
                setManagerEditNodeId(null);
                setManagerOpen(true);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="inline-flex h-8 items-center rounded border border-border px-2 text-xs hover:bg-muted"
              onClick={() => {
                void saveManagerEditDialog();
              }}
            >
              Save
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
                    renderManagerNodes(bookmarks.roots.bookmark_bar.children, bookmarks.roots.bookmark_bar.id)
                  ) : (
                    <div className="rounded border border-dashed border-border px-2 py-2 text-xs text-muted-foreground">Empty</div>
                  )}
                </div>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-muted-foreground">Other bookmarks</div>
                  {bookmarks.roots.other.children.length > 0 ? (
                    renderManagerNodes(bookmarks.roots.other.children, bookmarks.roots.other.id)
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
