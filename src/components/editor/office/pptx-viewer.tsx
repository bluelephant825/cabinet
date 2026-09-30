"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { PptxEditorHost } from "@/components/editor/documents/pptx-editor-host";
import { ViewerLayout } from "@/components/layout/viewer-layout";
import { useLocale } from "@/i18n/use-locale";
import { OfficeChrome } from "./office-chrome";

interface Props {
  path: string;
  title: string;
}

function ReadOnlyPresentation({ path, reason }: { path: string; reason?: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;
    container.innerHTML = "";
    let previewer: { destroy?: () => void } | null = null;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const [{ init }, response] = await Promise.all([
          import("pptx-preview"),
          fetch(`/api/assets/${path}`),
        ]);
        if (cancelled) return;
        if (!response.ok) throw new Error(`Failed to load file (${response.status})`);
        const width = container.clientWidth || 960;
        previewer = init(container, { width, height: Math.round((width * 9) / 16), mode: "list" }) as unknown as {
          destroy?: () => void;
          preview(buffer: ArrayBuffer): Promise<unknown>;
        };
        await (previewer as { preview(buffer: ArrayBuffer): Promise<unknown> }).preview(await response.arrayBuffer());
        if (!cancelled) setLoading(false);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Failed to render presentation");
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      try {
        previewer?.destroy?.();
      } catch {}
    };
  }, [path]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {reason ? <div className="px-4 py-2 text-xs text-muted-foreground bg-muted/40 border-b">{reason}</div> : null}
      <div className="flex-1 overflow-auto bg-muted/30 py-4">
        {loading && !error ? (
          <div className="h-[60vh] flex items-center justify-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            Rendering slides…
          </div>
        ) : null}
        {error ? <div className="h-[60vh] flex items-center justify-center text-sm text-destructive">{error}</div> : null}
        <div ref={containerRef} className="pptx-viewer-body mx-auto max-w-5xl px-4" />
      </div>
    </div>
  );
}

export function PptxViewer({ path, title }: Props) {
  const { t } = useLocale();
  const [status, setStatus] = useState<{ dirty: boolean; saving: boolean; error?: string }>({
    dirty: false,
    saving: false,
  });
  const statusBadge =
    status.dirty || status.saving || status.error ? (
      <span className="rounded-md border px-2 py-0.5 text-xs text-muted-foreground">
        {status.error ? status.error : status.saving ? t("docxEditor:saving") : t("docxEditor:unsaved")}
      </span>
    ) : null;
  return (
    <ViewerLayout toolbar={<OfficeChrome path={path} title={title} extLabel="PPTX" status={statusBadge} />}>
      <div className="flex-1 min-h-0 flex flex-col relative">
        <PptxEditorHost
          path={path}
          onStatus={setStatus}
          fallback={(reason) => <ReadOnlyPresentation path={path} reason={reason} />}
        />
      </div>
    </ViewerLayout>
  );
}
