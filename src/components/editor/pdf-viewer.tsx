"use client";

import { useState } from "react";
import { OfficeChrome } from "./office/office-chrome";
import { ViewerLayout } from "@/components/layout/viewer-layout";
import { useLocale } from "@/i18n/use-locale";
import { PdfEditorHost } from "@/components/editor/documents/pdf-editor-host";
import { ConvertToWordButton } from "@/components/editor/documents/convert-to-word";
import { useTreeStore } from "@/stores/tree-store";

interface PdfViewerProps {
  path: string;
  title: string;
}

/** Browser-native PDF render — the fallback when editing is unavailable. */
function BrowserPdfFallback({ path, title, reason }: { path: string; title: string; reason?: string }) {
  const pdfSrc = `/api/assets/${path}`;
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {reason && (
        <div className="px-4 py-2 text-xs text-muted-foreground bg-muted/40 border-b">
          {reason}
        </div>
      )}
      <iframe src={pdfSrc} className="flex-1 w-full border-0" title={title} />
    </div>
  );
}

export function PdfViewer({ path, title }: PdfViewerProps) {
  const { t } = useLocale();
  const pdfSrc = `/api/assets/${path}`;
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
        <OfficeChrome
          path={path}
          title={title}
          extLabel="PDF"
          status={statusBadge}
          actions={
            <ConvertToWordButton
              path={path}
              onNavigate={async (p) => {
                const { loadTree, focusPath } = useTreeStore.getState();
                await loadTree();
                focusPath(p);
              }}
            />
          }
          external={{ label: "Open in new tab", href: pdfSrc }}
        />
      }
    >
      <div className="flex-1 min-h-0 flex flex-col relative">
        <PdfEditorHost
          path={path}
          onStatus={setStatus}
          fallback={(reason) => (
            <BrowserPdfFallback path={path} title={title} reason={reason} />
          )}
        />
      </div>
    </ViewerLayout>
  );
}
