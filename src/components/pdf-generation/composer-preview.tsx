"use client";

/**
 * Preview pane: renders the REAL generated PDF (worker output, never a
 * PDFCN/React approximation) via pdf.js — page canvases, a thumbnail strip,
 * zoom, and a collapsible warnings list whose entries link back to the
 * offending outline node when they carry a nodeId.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { AlertTriangle, Loader2 } from "lucide-react";

import { useLocale } from "@/i18n/use-locale";
import { cn } from "@/lib/utils";
import { usePdfComposerStore } from "@/lib/documents/pdf-composer-store";

GlobalWorkerOptions.workerSrc = "/document-editor/pdfjs/pdf.worker.min.mjs";

function usePdfDocument(bytes: Uint8Array | null): {
  doc: PDFDocumentProxy | null;
  pageCount: number;
} {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  useEffect(() => {
    if (!bytes) {
      setDoc(null);
      return;
    }
    let cancelled = false;
    const task = getDocument({ data: bytes });
    void task.promise
      .then((d) => {
        if (cancelled) return;
        setDoc(d);
      })
      .catch(() => {
        if (!cancelled) setDoc(null);
      });
    return () => {
      cancelled = true;
      void task.destroy();
      setDoc(null);
    };
  }, [bytes]);
  return { doc, pageCount: doc?.numPages ?? 0 };
}

function PdfPageCanvas({
  doc,
  index,
  scale,
  className,
  onRendered,
}: {
  doc: PDFDocumentProxy;
  index: number;
  scale: number;
  className?: string;
  onRendered?: (h: number) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    void doc.getPage(index + 1).then((page) => {
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const canvas = ref.current;
      if (!canvas) return;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      void page
        .render({ canvas, canvasContext: ctx, viewport })
        .promise.then(() => onRendered?.(viewport.height))
        .catch(() => {});
    });
    return () => {
      cancelled = true;
    };
  }, [doc, index, scale, onRendered]);
  return <canvas ref={ref} className={className} data-page={index + 1} />;
}

export function ComposerPreview({ bytes }: { bytes: Uint8Array | null }) {
  const { t } = useLocale();
  const preview = usePdfComposerStore((s) => s.preview);
  const select = usePdfComposerStore((s) => s.select);
  const { doc, pageCount } = usePdfDocument(bytes);
  const [zoom, setZoom] = useState(0.9);
  const [page, setPage] = useState(0);
  const [warningsOpen, setWarningsOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [paneW, setPaneW] = useState(640);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPaneW(el.clientWidth));
    ro.observe(el);
    setPaneW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const pages = useMemo(() => Array.from({ length: pageCount }, (_, i) => i), [pageCount]);

  const goTo = (i: number) => {
    setPage(i);
    scrollRef.current
      ?.querySelector(`[data-page="${i + 1}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col" data-testid="pdf-preview">
      <div className="flex shrink-0 select-none items-center gap-2 border-b border-border px-2 py-1.5">
        {preview.rendering && (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> {t("pdfComposer:rendering")}
          </span>
        )}
        <span className="flex-1" />
        {pageCount > 0 && (
          <span className="text-[11px] text-muted-foreground">
            {page + 1} / {pageCount}
          </span>
        )}
        <select
          className="h-6 rounded border border-input bg-background px-1 text-[11px]"
          value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
          aria-label={t("pdfComposer:zoom")}
        >
          {[0.5, 0.75, 0.9, 1, 1.25, 1.5, 2].map((z) => (
            <option key={z} value={z}>
              {Math.round(z * 100)}%
            </option>
          ))}
        </select>
      </div>

      {preview.error && (
        <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
          {preview.error}
        </div>
      )}

      {preview.warnings.length > 0 && (
        <div className="select-none border-b border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[11px]">
          <button
            type="button"
            className="flex items-center gap-1 text-amber-700 dark:text-amber-400"
            onClick={() => setWarningsOpen(!warningsOpen)}
          >
            <AlertTriangle className="h-3 w-3" />
            {t("pdfComposer:warnings", { count: preview.warnings.length })}
          </button>
          {warningsOpen && (
            <ul className="mt-1 max-h-28 space-y-0.5 overflow-y-auto">
              {preview.warnings.map((w, i) => (
                <li key={i}>
                  {w.nodeId ? (
                    <button
                      type="button"
                      className="underline decoration-dotted"
                      onClick={() => select(w.nodeId!)}
                    >
                      {w.message}
                    </button>
                  ) : (
                    w.message
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {pageCount > 1 && paneW >= 480 && (
          <div className="w-20 shrink-0 select-none space-y-2 overflow-y-auto border-r border-border p-2">
            {pages.map((i) => (
              <button
                key={i}
                type="button"
                onClick={() => goTo(i)}
                className={cn(
                  "block w-full rounded border",
                  i === page ? "border-primary" : "border-border",
                )}
              >
                <PdfPageCanvas doc={doc!} index={i} scale={0.14} className="w-full" />
              </button>
            ))}
          </div>
        )}
        <div ref={scrollRef} className="flex-1 overflow-auto bg-muted/30 p-4">
          {!doc && !preview.rendering && (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              {t("pdfComposer:previewEmpty")}
            </div>
          )}
          {pages.map((i) => (
            <div
              key={i}
              className="mx-auto mb-4 w-fit shadow-md"
              onMouseEnter={() => setPage(i)}
            >
              <PdfPageCanvas doc={doc!} index={i} scale={zoom} className="block bg-white" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
