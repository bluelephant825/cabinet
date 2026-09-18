"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Blocks, Trash2, Loader2, Settings, Download, Play, RotateCw } from "lucide-react";
import { showError } from "@/lib/ui/toast";
import { useAppStore } from "@/stores/app-store";
import { ROOT_CABINET_PATH } from "@/lib/cabinets/paths";
import { useDaemonChannel } from "@/hooks/use-daemon-channel";
import {
  disableExtension,
  downloadBrowser,
  enableExtension,
  getStatus,
  installExtension,
  launch,
  listExtensions,
  openTab,
  shutdown,
  uninstallExtension,
  type SidecarExtension,
  type SidecarStatus,
} from "@/lib/browser/sidecar-client";

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

function showToast(kind: string, message: string): void {
  window.dispatchEvent(new CustomEvent("cabinet:toast", { detail: { kind, message } }));
}

const STATUS_LABELS: Record<string, string> = {
  missing: "Not downloaded",
  downloading: "Downloading",
  stopped: "Stopped",
  starting: "Starting",
  running: "Running",
  error: "Error",
};

export function ExtensionsSection() {
  const [extensions, setExtensions] = useState<SidecarExtension[]>([]);
  const [status, setStatus] = useState<SidecarStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [extensionUrlOrId, setExtensionUrlOrId] = useState("");

  const refreshStatus = useCallback(() => {
    void getStatus()
      .then(setStatus)
      .catch(() => {});
  }, []);

  const refreshExtensions = useCallback(() => {
    void listExtensions()
      .then(setExtensions)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refreshStatus();
    refreshExtensions();
  }, [refreshStatus, refreshExtensions]);

  // Live updates: status transitions, download progress, extension changes.
  const busEventRef = useRef<(data: Record<string, unknown>) => void>(() => {});
  busEventRef.current = (data) => {
    const type = typeof data.type === "string" ? data.type : "";
    if (type === "browser:status") {
      // The event only carries the status name; refetch for error/eligible.
      refreshStatus();
      return;
    }
    if (type === "browser:download") {
      const downloadedBytes = Number(data.downloadedBytes) || 0;
      const totalBytes = Number(data.totalBytes) || 0;
      setStatus((prev) =>
        prev
          ? { ...prev, status: "downloading", download: { downloadedBytes, totalBytes } }
          : prev,
      );
      return;
    }
    if (type === "browser:extension") {
      const action = typeof data.action === "string" ? data.action : "";
      const extension = data.extension as SidecarExtension | undefined;
      if (!extension?.id) {
        refreshExtensions();
        return;
      }
      setExtensions((prev) => {
        if (action === "removed") return prev.filter((ext) => ext.id !== extension.id);
        const index = prev.findIndex((ext) => ext.id === extension.id);
        if (index < 0) return [...prev, extension];
        const next = [...prev];
        next[index] = extension;
        return next;
      });
    }
  };
  const browserChannelHandler = useCallback(
    (data: Record<string, unknown>) => busEventRef.current(data),
    [],
  );
  useDaemonChannel("browser", browserChannelHandler);

  const handleInstall = async (e: React.FormEvent) => {
    e.preventDefault();
    const val = extensionUrlOrId.trim();
    if (!val) return;
    setInstalling(true);
    try {
      const ext = await installExtension(val);
      setExtensionUrlOrId("");
      showToast("success", `Extension installed: ${ext.name}`);
      refreshExtensions();
      refreshStatus();
    } catch (e2) {
      showError(errorMessage(e2, "Failed to install extension"));
    } finally {
      setInstalling(false);
    }
  };

  const handleUninstall = async (id: string) => {
    try {
      await uninstallExtension(id);
      setExtensions((prev) => prev.filter((ext) => ext.id !== id));
    } catch (e) {
      showError(errorMessage(e, "Failed to uninstall extension"));
    }
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    try {
      const ext = enabled ? await enableExtension(id) : await disableExtension(id);
      setExtensions((prev) => prev.map((entry) => (entry.id === id ? ext : entry)));
    } catch (e) {
      showError(errorMessage(e, "Failed to toggle extension"));
    }
  };

  const handleOpenOptions = async (ext: SidecarExtension) => {
    if (!ext.optionsPage || !ext.runtimeId) return;
    try {
      const url = `chrome-extension://${ext.runtimeId}/${ext.optionsPage}`;
      await openTab(url);
      const setSection = useAppStore.getState().setSection;
      const setAppMode = useAppStore.getState().setAppMode;
      setSection({ type: "cabinet", cabinetPath: ROOT_CABINET_PATH });
      setAppMode("browse", url);
    } catch (e) {
      showError(errorMessage(e, "Failed to open extension options"));
    }
  };

  const handleDownload = async () => {
    setLaunching(true);
    try {
      await downloadBrowser();
      refreshStatus();
    } catch (e) {
      showError(errorMessage(e, "Download failed"));
    } finally {
      setLaunching(false);
    }
  };

  const handleLaunch = async () => {
    setLaunching(true);
    try {
      if (status?.status === "running") {
        await shutdown();
      }
      await launch();
      refreshStatus();
    } catch (e) {
      showError(errorMessage(e, "Launch failed"));
    } finally {
      setLaunching(false);
    }
  };

  const downloadPercent =
    status?.download && status.download.totalBytes > 0
      ? Math.min(100, Math.round((status.download.downloadedBytes / status.download.totalBytes) * 100))
      : null;

  return (
    <div className="space-y-6">
      <div className="bg-card rounded-xl border p-5 shadow-sm">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-[13px] font-semibold flex items-center gap-2">
            <Blocks className="w-4 h-4" />
            Cabinet Browser
          </h3>
          <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
            {status ? STATUS_LABELS[status.status] ?? status.status : "…"}
          </span>
        </div>
        <p className="text-[12px] text-muted-foreground mb-3">
          Extensions run in the Cabinet Browser, a real Chrome for Testing window managed by Cabinet.
          Previously installed extensions are reinstalled automatically the first time the browser starts.
        </p>
        <div className="text-[11px] text-muted-foreground space-y-1">
          <div>
            Version: <span className="font-mono">{status?.version ?? "…"}</span>
          </div>
          {status?.executablePath ? (
            <div className="font-mono break-all opacity-70">{status.executablePath}</div>
          ) : null}
        </div>
        {status?.status === "downloading" ? (
          <div className="mt-3">
            <div className="h-1.5 w-full rounded bg-muted overflow-hidden">
              <div
                className="h-full bg-foreground/70 transition-all"
                style={{ width: `${downloadPercent ?? 10}%` }}
              />
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">
              Downloading…
              {status.download && status.download.totalBytes > 0
                ? ` ${(status.download.downloadedBytes / 1048576).toFixed(0)} / ${(status.download.totalBytes / 1048576).toFixed(0)} MB`
                : ""}
            </div>
          </div>
        ) : null}
        {status?.status === "error" && status.error ? (
          <p className="mt-2 text-[12px] text-destructive">{status.error}</p>
        ) : null}
        <div className="mt-3 flex items-center gap-2">
          {status?.status === "missing" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={launching}
              onClick={() => void handleDownload()}
            >
              {launching ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-2 h-3.5 w-3.5" />}
              Download
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={launching || status?.status === "downloading" || status?.status === "starting"}
              onClick={() => void handleLaunch()}
            >
              {launching ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : status?.status === "running" ? (
                <RotateCw className="mr-2 h-3.5 w-3.5" />
              ) : (
                <Play className="mr-2 h-3.5 w-3.5" />
              )}
              {status?.status === "running" ? "Restart" : "Launch"}
            </Button>
          )}
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground/70">
          Override the binary with CABINET_CHROMIUM_PATH or browser.chromiumPath in cabinet-config.json.
        </p>
      </div>

      <div className="bg-card rounded-xl border p-5 shadow-sm">
        <h3 className="text-[13px] font-semibold mb-1 flex items-center gap-2">
          <Blocks className="w-4 h-4" />
          Add Chrome Extension
        </h3>
        <p className="text-[12px] text-muted-foreground mb-4">
          Install an extension from the Chrome Web Store. Paste the extension URL or ID below. You can also install directly from the Web Store inside the Cabinet Browser.
        </p>
        <form onSubmit={handleInstall} className="flex gap-2">
          <Input
            className="flex-1"
            placeholder="e.g. https://chromewebstore.google.com/detail/... or Extension ID"
            value={extensionUrlOrId}
            onChange={(e) => setExtensionUrlOrId(e.target.value)}
            disabled={installing}
          />
          <Button type="submit" disabled={installing || !extensionUrlOrId.trim()}>
            {installing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Install
          </Button>
        </form>
      </div>

      <div className="bg-card rounded-xl border shadow-sm overflow-hidden">
        <div className="p-4 border-b bg-muted/20 flex items-center justify-between">
          <h3 className="text-[13px] font-semibold">Installed Extensions</h3>
        </div>
        <div className="divide-y">
          {loading ? (
            <div className="p-8 text-center text-muted-foreground flex items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : extensions.length === 0 ? (
            <div className="p-8 text-center text-[13px] text-muted-foreground">
              No extensions installed.
            </div>
          ) : (
            extensions.map((ext) => (
              <div key={ext.id} className="p-4 flex items-start gap-4">
                <div className="w-10 h-10 bg-muted rounded flex items-center justify-center shrink-0 overflow-hidden">
                  {ext.iconDataUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- icon is a data URL; next/image adds no value
                    <img src={ext.iconDataUrl} alt="" className="w-8 h-8 object-contain" />
                  ) : (
                    <Blocks className="w-5 h-5 text-muted-foreground" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <h4 className="text-[13px] font-semibold flex items-center gap-2">
                    {ext.name}
                    <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
                      v{ext.version}
                    </span>
                  </h4>
                  <p className="text-[12px] text-muted-foreground mt-1 line-clamp-2">
                    {ext.description || "No description provided."}
                  </p>
                  <p className="text-[10px] text-muted-foreground/60 mt-1 font-mono">
                    ID: {ext.id}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {ext.optionsPage && (
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={!ext.enabled || !ext.runtimeId}
                      onClick={() => void handleOpenOptions(ext)}
                      title={
                        !ext.enabled || !ext.runtimeId
                          ? "Enable the extension to open its options"
                          : "Extension options"
                      }
                    >
                      <Settings className="w-4 h-4" />
                    </Button>
                  )}
                  <Switch
                    checked={ext.enabled}
                    onCheckedChange={(checked) => void handleToggle(ext.id, checked)}
                    title={ext.enabled ? "Disable extension" : "Enable extension"}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={() => void handleUninstall(ext.id)}
                    title="Remove extension"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
