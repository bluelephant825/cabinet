"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";

import { ViewerLayout } from "@/components/layout/viewer-layout";
import { SafeHtml } from "@/components/ui/safe-html";
import { XlsxEditorHost } from "@/components/editor/documents/xlsx-editor-host";
import { cn } from "@/lib/utils";
import { useLocale } from "@/i18n/use-locale";
import { OfficeChrome } from "./office-chrome";

interface Props {
  path: string;
  title: string;
}

interface Sheet {
  name: string;
  html: string;
}

/** Existing SheetJS renderer, retained when the sidecar/editor is unavailable. */
function ReadOnlySpreadsheet({ path, reason }: { path: string; reason?: string }) {
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSheets(null);
    void Promise.all([import("xlsx"), fetch(`/api/assets/${path}`)])
      .then(async ([XLSX, response]) => {
        if (!response.ok) throw new Error(`Failed to load file (${response.status})`);
        const workbook = XLSX.read(await response.arrayBuffer(), {
          type: "array",
          cellDates: true,
          cellStyles: true,
        });
        if (cancelled) return;
        setSheets(
          workbook.SheetNames.map((name) => ({
            name,
            html: XLSX.utils.sheet_to_html(workbook.Sheets[name], { editable: false }),
          })),
        );
        setActive(0);
        setLoading(false);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Failed to parse spreadsheet");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const current = useMemo(() => sheets?.[active] ?? null, [sheets, active]);
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {reason ? (
        <div className="px-4 py-2 text-xs text-muted-foreground bg-muted/40 border-b">
          {reason}
        </div>
      ) : null}
      {sheets && sheets.length > 1 ? (
        <div className="flex items-center gap-0.5 border-b border-border bg-muted/40 px-2 overflow-x-auto scrollbar-none">
          {sheets.map((sheet, index) => (
            <button
              key={`${sheet.name}-${index}`}
              type="button"
              onClick={() => setActive(index)}
              className={cn(
                "px-3 py-1.5 text-[12px] rounded-t whitespace-nowrap transition-colors",
                index === active
                  ? "bg-background text-foreground font-medium border-t border-x border-border -mb-px"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {sheet.name}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex-1 overflow-auto">
        {loading && !error ? (
          <div className="h-full flex items-center justify-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            Parsing spreadsheet…
          </div>
        ) : null}
        {error ? (
          <div className="h-full flex items-center justify-center text-sm text-destructive">
            {error}
          </div>
        ) : null}
        {current ? <SafeHtml html={current.html} profile="table" className="xlsx-sheet p-3 text-[12px]" /> : null}
      </div>
    </div>
  );
}

export function XlsxViewer({ path, title }: Props) {
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
    <ViewerLayout toolbar={<OfficeChrome path={path} title={title} extLabel="XLSX" status={statusBadge} />}>
      <div className="flex-1 min-h-0 flex flex-col relative">
        <XlsxEditorHost
          path={path}
          onStatus={setStatus}
          fallback={(reason) => <ReadOnlySpreadsheet path={path} reason={reason} />}
        />
      </div>
    </ViewerLayout>
  );
}
