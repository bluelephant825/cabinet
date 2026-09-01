"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Code2, Columns2, Download, Eye, Loader2, RefreshCw, Save } from "lucide-react";
import { ToolbarButton } from "@/components/layout/toolbar-button";
import { ViewerLayout } from "@/components/layout/viewer-layout";
import { ViewerToolbar } from "@/components/layout/viewer-toolbar";

type ViewMode = "source" | "split" | "preview";

interface TypstViewerProps {
  path: string;
  title?: string;
}

export function TypstViewer({ path }: TypstViewerProps) {
  const [content, setContent] = useState("");
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<ViewMode>("source");
  const [loading, setLoading] = useState(true);
  const [compiling, setCompiling] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);

  const compileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const compileControllerRef = useRef<AbortController | null>(null);
  const compileSequenceRef = useRef(0);
  const savingRef = useRef(false);

  const assetUrl = `/api/assets/${path.split("/").map(encodeURIComponent).join("/")}`;
  const filename = path.split("/").pop() || path;

  const replacePdfUrl = useCallback((next: string | null) => {
    setPdfUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return next;
    });
  }, []);

  const compileTypst = useCallback(async (source: string) => {
    const sequence = ++compileSequenceRef.current;
    compileControllerRef.current?.abort();
    const controller = new AbortController();
    compileControllerRef.current = controller;
    setCompiling(true);
    setCompileError(null);

    try {
      const response = await fetch("/api/export/typst/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: source }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      const nextUrl = URL.createObjectURL(await response.blob());
      if (sequence !== compileSequenceRef.current) {
        URL.revokeObjectURL(nextUrl);
        return;
      }
      replacePdfUrl(nextUrl);
    } catch (error) {
      if (controller.signal.aborted || sequence !== compileSequenceRef.current) return;
      setCompileError(error instanceof Error ? error.message : "Failed to compile Typst document");
    } finally {
      if (sequence === compileSequenceRef.current) setCompiling(false);
    }
  }, [replacePdfUrl]);

  const fetchContent = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(assetUrl, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const source = await response.text();
      setContent(source);
      setDraft(source);
      setSaveError(null);
      void compileTypst(source);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Failed to load .typ file");
    } finally {
      setLoading(false);
    }
  }, [assetUrl, compileTypst]);

  useEffect(() => {
    void fetchContent();
    return () => {
      if (compileTimerRef.current) clearTimeout(compileTimerRef.current);
      compileControllerRef.current?.abort();
      compileSequenceRef.current += 1;
    };
  }, [fetchContent]);

  useEffect(() => () => replacePdfUrl(null), [replacePdfUrl]);

  const updateDraft = (value: string) => {
    setDraft(value);
    setSaveError(null);
    if (compileTimerRef.current) clearTimeout(compileTimerRef.current);
    compileTimerRef.current = setTimeout(() => void compileTypst(value), 500);
  };

  const handleSave = useCallback(async () => {
    if (savingRef.current || draft === content) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      const bridge = (window as unknown as {
        CabinetDesktop?: {
          writeFile?: (filePath: string, value: string) => Promise<{ ok: boolean; error?: string }>;
        };
      }).CabinetDesktop;
      if (bridge?.writeFile) {
        const result = await bridge.writeFile(path, draft);
        if (!result.ok) throw new Error(result.error || "Failed to save");
      } else {
        const response = await fetch(assetUrl, {
          method: "PUT",
          headers: { "Content-Type": "text/plain" },
          body: draft,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      }
      setContent(draft);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Failed to save");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [assetUrl, content, draft, path]);

  const sourceVisible = mode !== "preview";
  const previewVisible = mode !== "source";

  return (
    <ViewerLayout
      toolbar={
        <ViewerToolbar path={path} badge="TYP" sublabel={filename}>
          {sourceVisible && (
            <ToolbarButton
              icon={Save}
              label={saving ? "Saving…" : "Save"}
              disabled={saving || draft === content}
              onClick={() => void handleSave()}
            />
          )}
          <ToolbarButton icon={Code2} label="Source" iconOnly active={mode === "source"} onClick={() => setMode("source")} />
          <ToolbarButton icon={Columns2} label="Split" iconOnly active={mode === "split"} onClick={() => setMode("split")} />
          <ToolbarButton icon={Eye} label="Preview" iconOnly active={mode === "preview"} onClick={() => setMode("preview")} />
          <ToolbarButton
            icon={RefreshCw}
            label="Refresh"
            iconOnly
            disabled={loading}
            onClick={() => void fetchContent()}
            className={loading ? "[&_svg]:animate-spin" : undefined}
          />
          <ToolbarButton icon={Download} label="Download source" iconOnly href={assetUrl} download={filename} />
        </ViewerToolbar>
      }
      sheetClassName="bg-zinc-100 dark:bg-zinc-900"
    >
      {saveError && (
        <div className="flex items-start gap-2 border-b border-red-300 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-700/60 dark:bg-red-950/40 dark:text-red-300">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Couldn&apos;t save: {saveError}</span>
        </div>
      )}
      {loading ? (
        <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading Typst…
        </div>
      ) : loadError ? (
        <div className="flex h-full items-center justify-center gap-2 text-sm text-red-600 dark:text-red-400">
          <AlertCircle className="h-4 w-4" />
          {loadError}
        </div>
      ) : (
        <div className="flex h-full min-h-0 overflow-hidden">
          {sourceVisible && (
            <textarea
              value={draft}
              onChange={(event) => updateDraft(event.target.value)}
              onBlur={() => void handleSave()}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                  event.preventDefault();
                  void handleSave();
                }
              }}
              aria-label="Typst source"
              spellCheck={false}
              className="h-full min-h-0 flex-1 resize-none bg-zinc-950 p-4 font-mono text-sm leading-relaxed text-zinc-100 outline-none"
            />
          )}
          {previewVisible && (
            <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden border-l border-border">
              {compiling && (
                <div className="absolute right-2 top-2 z-10 flex items-center gap-1.5 rounded-md bg-background/85 px-2.5 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Compiling…
                </div>
              )}
              {compileError ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 overflow-auto p-6 text-center text-sm text-amber-700 dark:text-amber-400">
                  <AlertCircle className="h-5 w-5" />
                  <p className="font-medium">Compilation failed</p>
                  <pre className="max-w-xl whitespace-pre-wrap rounded-md border border-border bg-muted p-3 text-left text-xs">{compileError}</pre>
                </div>
              ) : pdfUrl ? (
                <iframe src={pdfUrl} title={`${filename} preview`} className="h-full w-full border-0" />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Waiting for compilation output…</div>
              )}
            </div>
          )}
        </div>
      )}
    </ViewerLayout>
  );
}
