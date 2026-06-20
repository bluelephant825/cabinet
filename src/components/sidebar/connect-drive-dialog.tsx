"use client";

import { useCallback, useEffect, useState } from "react";
import { Cloud, CloudOff, Folder, ChevronRight, ArrowUp, Loader2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { GDRIVE_MOUNTS_CHANGED_EVENT } from "@/components/sidebar/google-drive-tree";
import { useTreeStore } from "@/stores/tree-store";
import { providerLabel } from "@/lib/knowledge-sources/providers";
import type { KnowledgeProviderId } from "@/lib/knowledge-sources/store";

interface BrowseDir {
  name: string;
  path: string;
}

type Policy = "read-only" | "read-write";

function toast(kind: "success" | "error" | "info", message: string) {
  window.dispatchEvent(
    new CustomEvent("cabinet:toast", { detail: { kind, message } }),
  );
}

/**
 * Connect Knowledge → Google Drive (browser surface). Browses the local
 * Drive-for-Desktop mount, lets the user pick a sub-folder, choose a
 * per-connection read/write policy (default view-only), and connect it into the
 * active room's Drive browser (per-room knowledge source). No OAuth — it reads
 * the desktop-sync folder. See docs/CONNECT_KNOWLEDGE_PRD.md §6.
 */
export function ConnectDriveDialog({
  open,
  onOpenChange,
  cabinetPath,
  mountAt,
  provider = "google-drive",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cabinetPath: string;
  /**
   * When set, the folder is mounted INLINE as a symlink under this tree path
   * (F2) instead of into the room's Drive browser. Undefined → browser surface.
   */
  mountAt?: string;
  /** Which desktop-sync provider to browse/connect (default Google Drive). */
  provider?: KnowledgeProviderId;
}) {
  const [detected, setDetected] = useState<boolean | null>(null);
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState<string>("");
  const [dirs, setDirs] = useState<BrowseDir[]>([]);
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [policy, setPolicy] = useState<Policy>("read-only");
  const loadTree = useTreeStore((s) => s.loadTree);

  const label = providerLabel(provider);
  const statusQs = `?provider=${encodeURIComponent(provider)}${
    cabinetPath ? `&cabinet=${encodeURIComponent(cabinetPath)}` : ""
  }`;

  const browse = useCallback(async (target: string) => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/google-drive/browse?path=${encodeURIComponent(target)}&provider=${encodeURIComponent(provider)}`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        setDirs([]);
        return;
      }
      const data = (await res.json()) as { path: string; dirs: BrowseDir[] };
      setCurrentPath(data.path);
      setDirs(data.dirs);
    } catch {
      setDirs([]);
    } finally {
      setLoading(false);
    }
  }, [provider]);

  // Load detection + Drive root each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPolicy("read-only");
    setDetected(null);
    (async () => {
      try {
        const res = await fetch(`/api/google-drive/status${statusQs}`, { cache: "no-store" });
        const data = (await res.json()) as { desktopDetected: boolean; mountPath: string | null };
        if (cancelled) return;
        setDetected(data.desktopDetected);
        setRootPath(data.mountPath);
        if (data.mountPath) await browse(data.mountPath);
      } catch {
        if (!cancelled) setDetected(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, statusQs, browse]);

  const atRoot = rootPath !== null && currentPath === rootPath;
  const folderName = currentPath
    ? currentPath.split("/").filter(Boolean).pop() ?? "Drive"
    : "Drive";

  const goUp = () => {
    if (atRoot || !currentPath) return;
    const parent = currentPath.split("/").slice(0, -1).join("/");
    void browse(parent || "/");
  };

  const connect = async () => {
    if (!currentPath) return;
    setConnecting(true);
    try {
      const inline = mountAt !== undefined;
      const res = await fetch(
        inline ? "/api/knowledge-sources/connect-inline" : "/api/google-drive/mounts",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            inline
              ? {
                  provider,
                  absPath: currentPath,
                  name: folderName,
                  cabinet: cabinetPath,
                  policy,
                  parentPath: mountAt,
                }
              : { absPath: currentPath, folderName, cabinet: cabinetPath, policy, provider },
          ),
        },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        toast("error", data.error ?? `Failed to connect (${res.status})`);
        return;
      }
      if (inline) {
        // The symlink is a new tree node — refresh the tree to show it.
        await loadTree({ fresh: true });
      } else {
        window.dispatchEvent(new Event(GDRIVE_MOUNTS_CHANGED_EVENT));
      }
      toast("success", `Connected "${folderName}"`);
      onOpenChange(false);
    } catch {
      toast("error", "Failed to connect");
    } finally {
      setConnecting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Cloud className="h-4 w-4 text-blue-400" /> Connect a {label} folder
          </DialogTitle>
        </DialogHeader>

        {detected === false ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <CloudOff className="h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              {label} isn&apos;t detected on this Mac. Install its desktop app and
              sign in, then try again.
            </p>
          </div>
        ) : detected === null ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/60" />
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2"
                onClick={goUp}
                disabled={atRoot}
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </Button>
              <span className="truncate font-mono">{folderName}</span>
            </div>

            <div className="h-56 overflow-y-auto rounded-md border border-border">
              {loading ? (
                <div className="flex h-full items-center justify-center">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/60" />
                </div>
              ) : dirs.length === 0 ? (
                <p className="p-3 text-[12px] text-muted-foreground">No subfolders here.</p>
              ) : (
                dirs.map((d) => (
                  <button
                    key={d.path}
                    type="button"
                    onClick={() => void browse(d.path)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-foreground/[0.04]"
                  >
                    <Folder className="h-4 w-4 shrink-0 text-amber-500/80" />
                    <span className="min-w-0 flex-1 truncate">{d.name}</span>
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
                  </button>
                ))
              )}
            </div>

            <div className="flex items-center gap-2">
              {(["read-only", "read-write"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPolicy(p)}
                  className={cn(
                    "flex-1 rounded-md border px-3 py-1.5 text-[12px] transition-colors",
                    policy === p
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {policy === p && <Check className="me-1 inline h-3 w-3" />}
                  {p === "read-only" ? "View only" : "Read & write"}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {policy === "read-only"
                ? "Agents can read these files. Nothing in Cabinet can change them."
                : "Edits in Cabinet sync back to Google Drive."}
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={connect} disabled={detected !== true || connecting || !currentPath}>
            {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : `Connect "${folderName}"`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
