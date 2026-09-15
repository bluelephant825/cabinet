"use client";

/**
 * Shared host for the iframe document editors (DOCX and PDF): opens a
 * document session, mounts the same-origin `/document-editor` iframe with
 * `format=<format>` and drives the frame bridge. Falls back to a read-only
 * viewer when the document isn't editable.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { createHostBridge, type BridgeMessage } from "@/lib/documents/frame-bridge";
import { useLocale } from "@/i18n/use-locale";
import { useDocumentStore } from "@/lib/documents/document-store";
import { useDaemonChannel } from "@/hooks/use-daemon-channel";

interface Props {
  path: string;
  format: "docx" | "pdf";
  /** Rendered instead of the iframe when editing is unavailable. */
  fallback: (reason?: string) => React.ReactNode;
  /** Live status forwarded into the toolbar slot by the parent. */
  onStatus?: (s: { dirty: boolean; saving: boolean; error?: string }) => void;
  onNavigate?: (path: string) => void;
}

interface OpenResult {
  sessionId: string;
  revision: string;
  format: string;
  capabilities: { edit: boolean; convert: boolean };
  readOnlyReason?: string;
}

function randomChannel(): string {
  return `doc-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

type FlushRef = { current: ((ok: boolean) => void) | null };

/** Module scope so the react-compiler sees no hook-owned value being mutated. */
function settleFlush(ref: FlushRef, ok: boolean) {
  ref.current?.(ok);
  ref.current = null;
}

function setFlush(ref: FlushRef, done: (ok: boolean) => void) {
  ref.current = done;
}

export function DocumentEditorHost({ path, format, fallback, onStatus, onNavigate }: Props) {
  const { t } = useLocale();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const bridgeRef = useRef<ReturnType<typeof createHostBridge> | null>(null);
  const sessionRef = useRef<OpenResult | null>(null);
  const [mode, setMode] = useState<"loading" | "edit" | "readonly">("loading");
  const [reason, setReason] = useState<string | undefined>();
  const channelRef = useRef(randomChannel());

  const send = useCallback((type: Parameters<ReturnType<typeof createHostBridge>["send"]>[0], payload?: Record<string, unknown>) => {
    bridgeRef.current?.send(type, payload);
  }, []);

  // `init` payload — sent on iframe load and again when the frame asks for it.
  const sendInit = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    send("init", {
      virtualPath: path,
      sessionId: session.sessionId,
      revision: session.revision,
      readOnlyReason: session.readOnlyReason,
      theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
      locale: navigator.language,
    });
  }, [send, path]);

  const flush = useCallback(async () => {
    // Ask the frame to save; resolves when `saved` or `conflict` arrives.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Document save timed out")), 30_000);
      const done = (ok: boolean) => {
        clearTimeout(timer);
        if (ok) resolve();
        else reject(new Error("Document could not be saved"));
      };
      setFlush(pendingFlushRef, done);
      send("save-request");
    });
  }, [send]);
  const pendingFlushRef = useRef<((ok: boolean) => void) | null>(null);

  const onFrameMessage = useCallback(
    (msg: BridgeMessage) => {
      const store = useDocumentStore.getState();
      switch (msg.type) {
        case "ready":
          break;
        case "state":
          store.patch({
            dirty: Boolean(msg.dirty),
            saving: Boolean(msg.saving),
          });
          onStatus?.({
            dirty: Boolean(msg.dirty),
            saving: Boolean(msg.saving),
            error: msg.error as string | undefined,
          });
          break;
        case "saved":
          settleFlush(pendingFlushRef, true);
          store.patch({ dirty: false, saving: false });
          // Track the committed revision so the daemon-channel forwarder
          // below stops re-sending our own saves as `revision-changed`.
          if (sessionRef.current && typeof msg.revision === "string") {
            sessionRef.current.revision = msg.revision;
          }
          break;
        case "conflict":
          settleFlush(pendingFlushRef, false);
          onStatus?.({ dirty: true, saving: false, error: t("docxEditor:changedOnDisk") });
          break;
        case "request":
          if (msg.action === "init") {
            // Frame-side handshake — see the matching note in
            // docx-editor-frame.tsx.
            sendInit();
            return;
          }
          if (msg.action === "save-copy") {
            const session = sessionRef.current;
            if (!session) return;
            void fetch("/api/documents/save-copy", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                virtualPath: path,
                destinationVirtualPath: path,
                baseRevision: session.revision,
              }),
            })
              .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`save-copy ${r.status}`))))
              .then((res: { virtualPath?: string }) => {
                if (res.virtualPath) onNavigate?.(res.virtualPath);
              })
              .catch(() => {});
          }
          break;
      }
    },
    [onStatus, onNavigate, path, sendInit],
  );

  // Open the session, then mount the iframe.
  useEffect(() => {
    let cancelled = false;
    setMode("loading");
    void fetch("/api/documents/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ virtualPath: path }),
    })
      .then(async (r) => {
        const json = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(json.error ?? `open failed (${r.status})`);
        return json as OpenResult;
      })
      .then((session) => {
        if (cancelled) return;
        sessionRef.current = session;
        if (!session.capabilities.edit || session.format !== format) {
          setReason(session.readOnlyReason ?? t("docxEditor:readOnly"));
          setMode("readonly");
          return;
        }
        useDocumentStore.getState().setActive({ path, dirty: false, saving: false, flush });
        const iframe = iframeRef.current;
        if (!iframe) return;
        bridgeRef.current?.dispose();
        bridgeRef.current = createHostBridge(iframe, channelRef.current, onFrameMessage);
        iframe.src = `/document-editor#format=${format}&path=${encodeURIComponent(path)}&channel=${channelRef.current}`;
        setMode("edit");
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setReason(e.message);
        setMode("readonly");
      });
    return () => {
      cancelled = true;
      bridgeRef.current?.dispose();
      bridgeRef.current = null;
      const session = sessionRef.current;
      sessionRef.current = null;
      useDocumentStore.getState().setActive({ path: null, dirty: false, saving: false, flush: null });
      if (session) {
        void fetch("/api/documents/close", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: session.sessionId }),
        }).catch(() => {});
      }
    };
  }, [path, format, flush, onFrameMessage]);

  // Revision pushes: our own `cabinet:document-revision-changed` event and the
  // daemon's documents channel both forward `revision-changed` into the frame.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { path?: string; revision?: string };
      if (detail?.path === path) send("revision-changed", { revision: detail.revision });
    };
    window.addEventListener("cabinet:document-revision-changed", handler);
    return () => window.removeEventListener("cabinet:document-revision-changed", handler);
  }, [send, path]);

  useDaemonChannel("documents", (data) => {
    if (
      data.type === "document:changed" &&
      data.virtualPath === path &&
      data.revision !== sessionRef.current?.revision
    ) {
      send("revision-changed", { revision: data.revision });
    }
  });

  if (mode === "readonly") return <>{fallback(reason)}</>;
  return (
    <div className="flex-1 min-h-0 relative">
      {mode === "loading" && (
        <div className="h-full flex items-center justify-center text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" />
          {t("docxEditor:opening")}
        </div>
      )}
      <iframe
        ref={iframeRef}
        title="Document editor"
        className="absolute inset-0 w-full h-full border-0"
        onLoad={sendInit}
      />
    </div>
  );
}
