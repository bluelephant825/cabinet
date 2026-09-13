"use client";

/**
 * Editor for `.pdf.source.json` compositions: three-pane composer (palette /
 * outline / inspector) with Compose / Split / Preview modes, a real-PDF
 * preview produced by the document worker (never a client-side mock),
 * revision-checked saves through the daemon, and the publish conflict flow.
 *
 * Below ~1000px the palette and inspector collapse into overlay drawers.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Columns2,
  Eye,
  FileDown,
  FileText,
  Layers,
  Loader2,
  PanelLeft,
  PanelRight,
  Redo2,
  Save,
  SlidersHorizontal,
  Undo2,
} from "lucide-react";

import { migrateComposition, validateComposition } from "@/lib/documents/pdf-composition";
import { usePdfComposerStore, type OutputStatus } from "@/lib/documents/pdf-composer-store";
import { useDocumentStore } from "@/lib/documents/document-store";
import { useDaemonChannel } from "@/hooks/use-daemon-channel";
import { useLocale } from "@/i18n/use-locale";
import { useTreeStore } from "@/stores/tree-store";
import { ViewerLayout } from "@/components/layout/viewer-layout";
import { ViewerToolbar } from "@/components/layout/viewer-toolbar";
import { ToolbarButton } from "@/components/layout/toolbar-button";
import { SourceViewer } from "@/components/editor/source-viewer";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ComposerPalette } from "./composer-palette";
import { ComposerDnd, ComposerOutline } from "./composer-outline";
import { ComposerInspector } from "./composer-inspector";
import { ComposerPreview } from "./composer-preview";

type Mode = "compose" | "split" | "preview";
const MODE_KEY = "cabinet.pdfComposer.mode";
const NARROW_PX = 1000;

function loadMode(): Mode {
  try {
    const m = localStorage.getItem(MODE_KEY);
    if (m === "compose" || m === "split" || m === "preview") return m;
  } catch {
    /* ignore */
  }
  return "compose";
}

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.innerWidth < NARROW_PX,
  );
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${NARROW_PX - 1}px)`);
    const fn = () => setNarrow(mq.matches);
    fn();
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);
  return narrow;
}

function toast(kind: "success" | "error" | "info", message: string) {
  window.dispatchEvent(new CustomEvent("cabinet:toast", { detail: { kind, message } }));
}

async function jsonOr<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error((body as { error?: string }).error ?? `Request failed (${res.status})`) as Error & {
      code?: string;
      details?: Record<string, unknown>;
    };
    e.code = (body as { code?: string }).code;
    e.details = (body as { details?: Record<string, unknown> }).details;
    throw e;
  }
  return body as T;
}

interface JobInfo {
  jobId: string;
  status: string;
  result?: {
    previewKey?: string;
    cached?: boolean;
    pageCount?: number;
    warnings?: string[];
    virtualPath?: string;
  };
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

export function PdfCompositionEditor({ path, title }: { path: string; title: string }) {
  const { t } = useLocale();
  const store = usePdfComposerStore;
  const composition = usePdfComposerStore((s) => s.composition);
  const dirty = usePdfComposerStore((s) => s.dirty);
  const saving = usePdfComposerStore((s) => s.saving);
  const status = usePdfComposerStore((s) => s.status);
  const dirtyGeneration = usePdfComposerStore((s) => s.dirtyGeneration);
  const undoStack = usePdfComposerStore((s) => s.undoStack);
  const redoStack = usePdfComposerStore((s) => s.redoStack);

  const [phase, setPhase] = useState<"loading" | "ready" | "invalid">("loading");
  const [invalidReason, setInvalidReason] = useState<string | null>(null);
  const [mode, setModeState] = useState<Mode>("compose");
  const [saveConflict, setSaveConflict] = useState(false);
  const [diskChanged, setDiskChanged] = useState(false);
  const [publishConflict, setPublishConflict] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [previewBytes, setPreviewBytes] = useState<Uint8Array | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const narrow = useNarrow();
  const rootRef = useRef<HTMLDivElement>(null);
  const [editorW, setEditorW] = useState(1440);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setEditorW(el.clientWidth));
    ro.observe(el);
    setEditorW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Split pane budget: outline ~280px (min 220) + preview min 360px. Below
  // 1100px of editor width the inspector collapses to a drawer; below ~600px
  // the preview can't meet its minimum, so it moves to a drawer instead of
  // rendering as a sliver.
  const splitTooSmall = mode === "split" && editorW < 600;
  const inspectorAsDrawer = narrow || (mode === "split" && editorW < 1100);

  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const previewJobRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => setModeState(loadMode()), []);

  // ── load ────────────────────────────────────────────────────────────────

  const refreshStatus = useCallback(async () => {
    try {
      const s = await jsonOr<{ sourceRevision?: string; output?: OutputStatus }>(
        await fetch(`/api/documents/pdf-composition/status?path=${encodeURIComponent(path)}`),
      );
      store.getState().setStatus(s.output ?? null);
      if (s.sourceRevision) store.getState().setSourceRevision(s.sourceRevision);
    } catch {
      /* status is best-effort */
    }
  }, [path, store]);

  const loadSource = useCallback(async () => {
    setPhase("loading");
    try {
      const res = await fetch(`/api/assets/${path.split("/").map(encodeURIComponent).join("/")}`);
      if (!res.ok) throw new Error(`read failed (${res.status})`);
      const text = await res.text();
      const parsed: unknown = JSON.parse(text);
      const validated = validateComposition(migrateComposition(parsed));
      if (!validated.ok) {
        setInvalidReason(
          validated.errors.slice(0, 3).map((e) => `${e.path}: ${e.message}`).join("; "),
        );
        setPhase("invalid");
        return;
      }
      // The generic /documents/revision route only authorizes .docx/.pdf —
      // composition sources get their revision through the status route
      // (which also seeds the output status pill).
      const s = await jsonOr<{ sourceRevision?: string; output?: OutputStatus }>(
        await fetch(`/api/documents/pdf-composition/status?path=${encodeURIComponent(path)}`),
      );
      store.getState().load(path, validated.value, s.sourceRevision ?? "");
      store.getState().setStatus(s.output ?? null);
      setPhase("ready");
    } catch (e) {
      setInvalidReason(e instanceof Error ? e.message : String(e));
      setPhase("invalid");
    }
  }, [path, store]);

  useEffect(() => {
    mountedRef.current = true;
    void loadSource();
    return () => {
      mountedRef.current = false;
      store.getState().unload();
      if (pollRef.current) clearInterval(pollRef.current);
      if (previewTimer.current) clearTimeout(previewTimer.current);
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
  }, [loadSource, store]);

  // ── save ────────────────────────────────────────────────────────────────

  const save = useCallback(
    async (as?: "copy"): Promise<boolean> => {
      const s = store.getState();
      if (!s.composition) return false;
      s.setSaving(true);
      try {
        const body: Record<string, unknown> = {
          virtualPath: s.path!,
          composition: s.composition,
        };
        if (as !== "copy") body.baseRevision = s.sourceRevision ?? undefined;
        if (as === "copy") {
          const stem = s.path!.replace(/\.pdf\.source\.json$/, "");
          // Ask for a sibling; the create path collision-handling is
          // server-side for outputs but sources are explicit — pick (2).
          body.virtualPath = `${stem} (2).pdf.source.json`;
          body.composition = { ...s.composition };
        }
        const data = await jsonOr<{ revision: string }>(
          await fetch("/api/documents/pdf-composition/source", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        );
        if (as === "copy") {
          setSaveConflict(false);
          toast("success", t("pdfComposer:savedCopy"));
          const vp = body.virtualPath as string;
          const { loadTree, focusPath } = useTreeStore.getState();
          await loadTree({ fresh: true });
          focusPath(vp);
          return true;
        }
        s.markSaved(data.revision);
        setSaveConflict(false);
        void refreshStatus();
        return true;
      } catch (e) {
        const err = e as Error & { code?: string };
        if (err.code === "conflict") {
          setSaveConflict(true);
        } else {
          toast("error", err.message);
        }
        return false;
      } finally {
        s.setSaving(false);
      }
    },
    [store, refreshStatus, t],
  );

  // Cmd/Ctrl+S.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  // 2s idle autosave.
  useEffect(() => {
    if (!dirty) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      if (usePdfComposerStore.getState().dirty) void save();
    }, 2000);
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
  }, [dirtyGeneration, dirty, save]);

  // Register a flush so agent-scoped task dispatch can force a save.
  useEffect(() => {
    if (phase !== "ready") return;
    useDocumentStore.getState().setActive({
      path,
      dirty: false,
      saving: false,
      flush: async () => {
        if (!(await save())) throw new Error("PDF composition could not be saved");
      },
    });
    return () => {
      useDocumentStore.getState().setActive({ path: null, dirty: false, saving: false, flush: null });
    };
  }, [phase, path, save]);

  useEffect(() => {
    useDocumentStore.getState().patch({ dirty, saving });
  }, [dirty, saving]);

  // ── preview render pipeline ─────────────────────────────────────────────

  const stopPoll = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);

  const runPreview = useCallback(async () => {
    const s = store.getState();
    if (!s.composition || phase !== "ready") return;
    // Preview renders the committed source — flush pending edits first.
    if (s.dirty) {
      if (!(await save())) return;
    }
    if (previewJobRef.current) {
      void fetch(`/api/documents/jobs/${previewJobRef.current}/cancel`, { method: "POST" }).catch(
        () => {},
      );
      previewJobRef.current = null;
    }
    s.setPreview({ rendering: true, error: null });
    try {
      const { jobId } = await jsonOr<{ jobId: string }>(
        await fetch("/api/documents/pdf-composition/render", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sourceVirtualPath: s.path!, mode: "preview" }),
        }),
      );
      previewJobRef.current = jobId;
      stopPoll();
      pollRef.current = setInterval(async () => {
        try {
          const job = await jsonOr<JobInfo>(await fetch(`/api/documents/jobs/${jobId}`));
          if (job.status === "done") {
            stopPoll();
            previewJobRef.current = null;
            const key = job.result?.previewKey;
            if (!key) return;
            const bytes = new Uint8Array(
              await (await fetch(`/api/documents/preview/${key}`)).arrayBuffer(),
            );
            if (!mountedRef.current) return;
            setPreviewBytes(bytes);
            store.getState().setPreview({
              key,
              jobId: null,
              pageCount: job.result?.pageCount ?? 0,
              warnings: (job.result?.warnings ?? []).map((message) => ({ message })),
              rendering: false,
              error: null,
            });
          } else if (job.status === "failed" || job.status === "cancelled") {
            stopPoll();
            previewJobRef.current = null;
            if (job.status === "failed") {
              store.getState().setPreview({
                rendering: false,
                error: job.error?.message ?? t("pdfComposer:renderFailed"),
              });
            } else {
              store.getState().setPreview({ rendering: false });
            }
          }
        } catch {
          /* transient poll failure — keep polling */
        }
      }, 600);
    } catch (e) {
      s.setPreview({
        rendering: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, [phase, save, stopPoll, store, t]);

  const schedulePreview = useCallback(() => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => void runPreview(), 800);
  }, [runPreview]);

  // Debounced preview after edits + the initial render.
  useEffect(() => {
    if (phase !== "ready") return;
    schedulePreview();
  }, [dirtyGeneration, phase, schedulePreview]);

  // ── external changes ────────────────────────────────────────────────────

  useDaemonChannel("documents", (data) => {
    if (data.type !== "document:changed" || data.virtualPath !== path) return;
    const s = usePdfComposerStore.getState();
    if (data.revision === s.sourceRevision) return; // our own commit
    if (s.dirty) setDiskChanged(true);
    else void loadSource();
  });

  // ── publish ─────────────────────────────────────────────────────────────

  const publish = useCallback(
    async (opts?: { replace?: boolean; saveAsCopy?: boolean }) => {
      const s = store.getState();
      if (!s.composition) return;
      setPublishing(true);
      setPublishConflict(false);
      try {
        if (s.dirty && !(await save())) return;
        const { jobId } = await jsonOr<{ jobId: string }>(
          await fetch("/api/documents/pdf-composition/render", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              sourceVirtualPath: s.path!,
              mode: "publish",
              ...opts,
            }),
          }),
        );
        // Poll the publish job to its terminal state.
        const job = await new Promise<JobInfo>((resolve) => {
          const iv = setInterval(async () => {
            try {
              const j = await jsonOr<JobInfo>(await fetch(`/api/documents/jobs/${jobId}`));
              if (j.status !== "queued" && j.status !== "running") {
                clearInterval(iv);
                resolve(j);
              }
            } catch {
              /* keep polling */
            }
          }, 700);
        });
        if (job.status === "done") {
          toast("success", t("pdfComposer:published", { path: job.result?.virtualPath ?? "" }));
          void refreshStatus();
          void useTreeStore.getState().loadTree({ fresh: true });
        } else if (
          job.error?.code === "conflict" &&
          (job.error.details as { reason?: string } | undefined)?.reason === "output-modified"
        ) {
          setPublishConflict(true);
        } else {
          toast("error", job.error?.message ?? t("pdfComposer:renderFailed"));
        }
      } catch (e) {
        const err = e as Error & { code?: string; details?: Record<string, unknown> };
        if (err.code === "conflict" && err.details?.reason === "output-modified") {
          setPublishConflict(true);
        } else {
          toast("error", err.message);
        }
      } finally {
        setPublishing(false);
      }
    },
    [save, store, refreshStatus, t],
  );

  const openOutput = useCallback(async () => {
    const out = usePdfComposerStore.getState().status?.virtualPath;
    if (!out) return;
    const { loadTree, focusPath } = useTreeStore.getState();
    await loadTree({ fresh: true });
    focusPath(out);
  }, []);

  // ── status pill ─────────────────────────────────────────────────────────

  const statusPill = useMemo(() => {
    if (!status) return { label: t("pdfComposer:noPdf"), cls: "text-muted-foreground" };
    if (status.modified)
      return { label: t("pdfComposer:pdfModified"), cls: "text-amber-600 border-amber-500/40" };
    if (status.stale)
      return { label: t("pdfComposer:pdfStale"), cls: "text-amber-600 border-amber-500/40" };
    return { label: t("pdfComposer:pdfCurrent"), cls: "text-emerald-600 border-emerald-500/40" };
  }, [status, t]);

  // ── render ──────────────────────────────────────────────────────────────

  if (phase === "invalid") {
    return (
      <ViewerLayout
        toolbar={<ViewerToolbar path={path} badge="PDF SOURCE">{null}</ViewerToolbar>}
      >
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
            <span className="text-amber-700 dark:text-amber-400">
              {t("pdfComposer:invalidBanner")}
              {invalidReason ? ` — ${invalidReason}` : ""}
            </span>
          </div>
          <div className="min-h-0 flex-1">
            <SourceViewer path={path} title={title} />
          </div>
        </div>
      </ViewerLayout>
    );
  }

  const toolbar = (
    <ViewerToolbar path={path} badge="PDF SOURCE">
      {narrow && (
        <ToolbarButton
          icon={PanelLeft}
          label={t("pdfComposer:blocks")}
          iconOnly
          onClick={() => setPaletteOpen(true)}
        />
      )}
      {inspectorAsDrawer && mode !== "preview" && (
        <ToolbarButton
          icon={SlidersHorizontal}
          label={t("pdfComposer:inspector")}
          iconOnly
          onClick={() => setInspectorOpen(true)}
        />
      )}
      {splitTooSmall && (
        <ToolbarButton
          icon={Eye}
          label={t("pdfComposer:modePreview")}
          iconOnly
          onClick={() => setPreviewOpen(true)}
        />
      )}
      <ToolbarButton
        icon={Undo2}
        label={t("pdfComposer:undo")}
        iconOnly
        disabled={undoStack.length === 0}
        onClick={() => store.getState().undo()}
      />
      <ToolbarButton
        icon={Redo2}
        label={t("pdfComposer:redo")}
        iconOnly
        disabled={redoStack.length === 0}
        onClick={() => store.getState().redo()}
      />
      <span className="mx-1 flex overflow-hidden rounded-md border border-border text-[11px]">
        {(
          [
            ["compose", Layers, t("pdfComposer:modeCompose")],
            ["split", Columns2, t("pdfComposer:modeSplit")],
            ["preview", Eye, t("pdfComposer:modePreview")],
          ] as const
        ).map(([m, Icon, label]) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={cn(
              "flex items-center gap-1 px-2 py-1 transition-colors",
              mode === m ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-accent/60",
            )}
          >
            <Icon className="h-3 w-3" />
            <span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </span>
      <ToolbarButton
        icon={Save}
        label={saving ? t("docxEditor:saving") : t("pdfComposer:save")}
        iconOnly={narrow || editorW < 900}
        disabled={!dirty || saving}
        onClick={() => void save()}
      />
      <ToolbarButton
        icon={FileDown}
        label={publishing ? t("pdfComposer:generating") : t("pdfComposer:generate")}
        iconOnly={narrow || editorW < 900}
        disabled={publishing}
        onClick={() => void publish()}
      />
      <span
        data-testid="pdf-status-pill"
        className={cn("rounded-md border px-2 py-0.5 text-[11px]", statusPill.cls)}
      >
        {statusPill.label}
      </span>
      {status && (
        <ToolbarButton
          icon={FileText}
          label={t("pdfComposer:openPdf")}
          iconOnly={narrow || editorW < 900}
          onClick={() => void openOutput()}
        />
      )}
    </ViewerToolbar>
  );

  const showPalette = mode === "compose" && !narrow;
  const showInspector = mode !== "preview" && !inspectorAsDrawer;
  const showOutline = mode !== "preview";
  const showPreview = (mode === "split" && !splitTooSmall) || mode === "preview";

  return (
    <ViewerLayout toolbar={toolbar}>
      <div ref={rootRef} className="flex h-full min-h-0 flex-col">
        {saveConflict && (
          <div
            data-testid="pdf-save-conflict"
            className="flex items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs"
          >
            <span className="flex-1 text-destructive">{t("pdfComposer:saveConflict")}</span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => {
                setSaveConflict(false);
                void loadSource();
              }}
            >
              {t("pdfComposer:reloadLatest")}
            </Button>
            <Button size="sm" className="h-7 text-xs" onClick={() => void save("copy")}>
              {t("pdfComposer:saveCopy")}
            </Button>
          </div>
        )}
        {diskChanged && (
          <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
            <span className="flex-1">{t("pdfComposer:diskChanged")}</span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => {
                setDiskChanged(false);
                void loadSource();
              }}
            >
              {t("pdfComposer:reloadLatest")}
            </Button>
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          <ComposerDnd>
            {showPalette && (
              <div className="w-44 shrink-0 overflow-hidden border-r border-border">
                <ComposerPalette />
              </div>
            )}
            {showOutline && (
              <div
                className={cn(
                  "min-h-0 flex-1 overflow-hidden",
                  showPreview && "w-[280px] min-w-[220px] flex-none border-r border-border",
                )}
              >
                {phase === "loading" || !composition ? (
                  <div className="flex h-full items-center justify-center text-muted-foreground">
                    <Loader2 className="h-5 w-5 animate-spin" />
                  </div>
                ) : (
                  <ComposerOutline />
                )}
              </div>
            )}
            {showPreview && (
              <div className={cn("min-h-0 flex-1 overflow-hidden", mode === "split" && "min-w-[360px]")}>
                <ComposerPreview bytes={previewBytes} />
              </div>
            )}
            {showInspector && (
              <div
                className={cn(
                  "shrink-0 overflow-hidden border-l border-border",
                  mode === "split" ? "w-[300px]" : "w-64",
                )}
              >
                <ComposerInspector />
              </div>
            )}
          </ComposerDnd>
        </div>
      </div>

      {/* Narrow-screen overlay drawers */}
      {narrow && paletteOpen && (
        <div className="absolute inset-0 z-40 flex" data-testid="pdf-palette-drawer">
          <div className="h-full w-56 border-r border-border bg-background shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-2 py-1.5">
              <span className="text-[11px] font-semibold uppercase text-muted-foreground">
                {t("pdfComposer:blocks")}
              </span>
              <button type="button" onClick={() => setPaletteOpen(false)} aria-label="close palette">
                <PanelRight className="h-4 w-4" />
              </button>
            </div>
            <ComposerPalette />
          </div>
          <button
            type="button"
            aria-label="close"
            className="flex-1 bg-black/30"
            onClick={() => setPaletteOpen(false)}
          />
        </div>
      )}
      {inspectorAsDrawer && inspectorOpen && (
        <div className="absolute inset-0 z-40 flex justify-end" data-testid="pdf-inspector-drawer">
          <button
            type="button"
            aria-label="close"
            className="flex-1 bg-black/30"
            onClick={() => setInspectorOpen(false)}
          />
          <div className="h-full w-72 border-l border-border bg-background shadow-xl">
            <ComposerInspector />
          </div>
        </div>
      )}
      {splitTooSmall && previewOpen && (
        <div className="absolute inset-0 z-40 flex justify-end" data-testid="pdf-preview-drawer">
          <button
            type="button"
            aria-label="close"
            className="flex-1 bg-black/30"
            onClick={() => setPreviewOpen(false)}
          />
          <div className="flex h-full w-[480px] max-w-[90%] flex-col border-l border-border bg-background shadow-xl">
            <ComposerPreview bytes={previewBytes} />
          </div>
        </div>
      )}

      {/* Output-modified publish conflict */}
      <Dialog open={publishConflict} onOpenChange={setPublishConflict}>
        <DialogContent className="max-w-md" data-testid="pdf-publish-conflict">
          <DialogTitle>{t("pdfComposer:conflictTitle")}</DialogTitle>
          <p className="text-sm text-muted-foreground">{t("pdfComposer:conflictBody")}</p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setPublishConflict(false)}>
              {t("common:actions.cancel")}
            </Button>
            <Button variant="outline" onClick={() => void publish({ saveAsCopy: true })}>
              {t("pdfComposer:saveAsNew")}
            </Button>
            <Button onClick={() => void publish({ replace: true })}>
              {t("pdfComposer:replace")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </ViewerLayout>
  );
}
