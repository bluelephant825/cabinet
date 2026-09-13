"use client";

import { useEffect, useRef, useState } from "react";
import { OfficeChrome } from "./office-chrome";
import { ViewerLayout } from "@/components/layout/viewer-layout";
import { useLocale } from "@/i18n/use-locale";
import { DocxEditorHost } from "@/components/editor/documents/docx-editor-host";
import { Loader2 } from "lucide-react";

interface Props {
  path: string;
  title: string;
}

/** Existing read-only render (docx-preview) — the fallback when editing is unavailable. */
function ReadOnlyPreview({ path, reason }: { path: string; reason?: string }) {
  const { t } = useLocale();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;

    container.innerHTML = "";

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [{ renderAsync }, res] = await Promise.all([
          import("docx-preview"),
          fetch(`/api/assets/${path}`),
        ]);
        if (cancelled) return;
        if (!res.ok) throw new Error(`Failed to load file (${res.status})`);
        const blob = await res.blob();
        if (cancelled) return;
        await renderAsync(blob, container, undefined, {
          className: "docx-rendered",
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          breakPages: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          experimental: true,
          useBase64URL: true,
        });
        if (!cancelled) setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to render document");
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [path]);

  return (
    <div className="flex-1 overflow-y-auto bg-muted/30">
      {reason && (
        <div className="px-4 py-2 text-xs text-muted-foreground bg-muted/40 border-b">
          {reason}
        </div>
      )}
      {loading && !error && (
        <div className="h-full flex items-center justify-center text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" />
          {t("docxEditor:rendering")}
        </div>
      )}
      {error && (
        <div className="h-full flex items-center justify-center">
          <div className="text-center space-y-2">
            <p className="text-sm text-destructive">{error}</p>
            <p className="text-xs text-muted-foreground">
              {t("docxEditor:tryExternal")}
            </p>
          </div>
        </div>
      )}
      <div ref={containerRef} className="docx-viewer-body mx-auto max-w-5xl py-6 px-4" />
    </div>
  );
}

export function DocxViewer({ path, title }: Props) {
  const { t } = useLocale();
  const [status, setStatus] = useState<{ dirty: boolean; saving: boolean; error?: string }>({
    dirty: false,
    saving: false,
  });

  const statusBadge =
    status.dirty || status.saving || status.error ? (
      <span className="rounded-md border px-2 py-0.5 text-xs text-muted-foreground">
        {status.error
          ? status.error
          : status.saving
            ? t("docxEditor:saving")
            : t("docxEditor:unsaved")}
      </span>
    ) : null;

  return (
    <ViewerLayout
      toolbar={
        <OfficeChrome path={path} title={title} extLabel="DOCX" status={statusBadge} />
      }
    >
      <div className="flex-1 min-h-0 flex flex-col relative">
        <DocxEditorHost
          path={path}
          onStatus={setStatus}
          fallback={(reason) => <ReadOnlyPreview path={path} reason={reason} />}
        />
      </div>
    </ViewerLayout>
  );
}
