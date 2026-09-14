"use client";

/**
 * "Convert" toolbar action + dialog for PDF and DOCX documents. A dropdown
 * offers the formats valid for the source (PDF → Word/Markdown, DOCX →
 * Markdown); the dialog plans the destination, runs the convert job, and
 * reports every created file. Shared by the PDF viewer and the DOCX
 * surfaces — conversion only needs the document service's convert job.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, Loader2 } from "lucide-react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLocale } from "@/i18n/use-locale";
import { useDaemonChannel } from "@/hooks/use-daemon-channel";
import { useDocumentStore } from "@/lib/documents/document-store";
import type { ConvertPlanResult, ConvertTarget, JobInfo } from "@/lib/documents/types";
import { findNodeByPath } from "@/lib/cabinets/tree";
import { useAppStore } from "@/stores/app-store";
import { useEditorStore } from "@/stores/editor-store";
import { useTreeStore } from "@/stores/tree-store";

/**
 * Open a freshly converted file the way a tree click does. Markdown page
 * nodes strip `.md`/`.mdx` from their tree path, so the raw virtualPath alone
 * resolves to no node and the page editor falls back to the previous room —
 * resolve the node first and fall back to the extensionless page path.
 */
export async function openConvertedDocument(virtualPath: string): Promise<void> {
  const { loadTree, focusPath } = useTreeStore.getState();
  await loadTree();
  const stemPath = virtualPath.replace(/\.(md|mdx)$/i, "");
  const node =
    findNodeByPath(useTreeStore.getState().nodes, virtualPath) ??
    findNodeByPath(useTreeStore.getState().nodes, stemPath);
  const target = node?.path ?? stemPath;
  focusPath(target);
  await useEditorStore.getState().loadPage(target);
  useAppStore.getState().setSection({ type: "page" });
}

type Phase =
  | { kind: "plan" }
  | { kind: "running"; jobId: string }
  | { kind: "done"; job: JobInfo }
  | { kind: "degraded"; job: JobInfo }
  | { kind: "failed"; message: string };

async function jsonOr<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
    (err as Error & { code?: string; details?: Record<string, unknown> }).code = (
      body as { code?: string }
    ).code;
    (err as Error & { details?: Record<string, unknown> }).details = (
      body as { details?: Record<string, unknown> }
    ).details;
    throw err;
  }
  return body as T;
}

export function ConvertDocumentButton({
  path,
  sourceFormat,
  onNavigate,
}: {
  path: string;
  sourceFormat: "pdf" | "docx";
  onNavigate?: (path: string) => void;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<ConvertTarget>("md");
  const [plan, setPlan] = useState<ConvertPlanResult | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "plan" });
  const [job, setJob] = useState<JobInfo | null>(null);
  const [language, setLanguage] = useState<string>("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);
  useEffect(() => stopPoll, [stopPoll]);

  const applyJob = useCallback((j: JobInfo) => {
    setJob(j);
    if (j.status === "done") {
      stopPoll();
      setPhase({ kind: "done", job: j });
    } else if (j.status === "failed") {
      stopPoll();
      if (j.error?.code === "degraded") setPhase({ kind: "degraded", job: j });
      else setPhase({ kind: "failed", message: j.error?.message ?? "Conversion failed" });
    } else if (j.status === "cancelled") {
      stopPoll();
      setPhase({ kind: "plan" });
      setJob(null);
    }
  }, [stopPoll]);

  // The daemon's documents channel pushes job transitions; polling covers
  // environments where the event stream isn't connected.
  useDaemonChannel("documents", (data) => {
    if (
      data.type === "document:job" &&
      (data.job as JobInfo | undefined)?.jobId === job?.jobId &&
      data.job
    ) {
      applyJob(data.job as JobInfo);
    }
  });

  const startPoll = useCallback(
    (jobId: string) => {
      stopPoll();
      pollRef.current = setInterval(() => {
        void fetch(`/api/documents/jobs/${jobId}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((j: JobInfo | null) => j && applyJob(j))
          .catch(() => {});
      }, 700);
    },
    [applyJob, stopPoll],
  );

  const fetchPlan = useCallback(
    async (forTarget: ConvertTarget) => {
      setPlan(null);
      setBusy(true);
      setError(null);
      try {
        // Flush pending edits first — the convert reads committed bytes.
        const store = useDocumentStore.getState();
        if (store.path === path && store.dirty && store.flush) {
          await store.flush();
        }
        setPlan(await jsonOr<ConvertPlanResult>(
          await fetch("/api/documents/convert/plan", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ virtualPath: path, target: forTarget }),
          }),
        ));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [path],
  );

  const openDialog = useCallback(
    (preset: ConvertTarget) => {
      setError(null);
      setPhase({ kind: "plan" });
      setJob(null);
      setTarget(preset);
      setOpen(true);
      void fetchPlan(preset);
    },
    [fetchPlan],
  );

  const switchTarget = useCallback(
    (next: ConvertTarget) => {
      setTarget(next);
      void fetchPlan(next);
    },
    [fetchPlan],
  );

  const startConvert = useCallback(
    async (acknowledgeDegraded = false) => {
      setBusy(true);
      setError(null);
      try {
        const rev = await jsonOr<{ revision: string }>(
          await fetch(`/api/documents/revision?path=${encodeURIComponent(path)}`),
        );
        const res = await jsonOr<{ jobId: string }>(
          await fetch("/api/documents/convert", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              virtualPath: path,
              baseRevision: rev.revision,
              target,
              ...(language ? { languageHints: [language] } : {}),
              ...(acknowledgeDegraded ? { acknowledgeDegraded: true } : {}),
            }),
          }),
        );
        const j = await jsonOr<JobInfo>(await fetch(`/api/documents/jobs/${res.jobId}`));
        setJob(j);
        setPhase({ kind: "running", jobId: res.jobId });
        startPoll(res.jobId);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [language, path, startPoll, target],
  );

  const cancelJob = useCallback(() => {
    if (phase.kind === "running") {
      void fetch(`/api/documents/jobs/${phase.jobId}/cancel`, { method: "POST" }).catch(() => {});
    }
  }, [phase]);

  const progressText = (() => {
    if (!job?.progress) return null;
    const p = job.progress;
    const phaseLabel = t(
      p.phase === "scan"
        ? "pdfConvert:phaseScan"
        : p.phase === "ocr"
          ? "pdfConvert:phaseOcr"
          : p.phase === "convert"
            ? "pdfConvert:phaseConvert"
            : p.phase === "markdown"
              ? "pdfConvert:phaseMarkdown"
              : "pdfConvert:phaseWrite",
    );
    return p.pageCount > 0 ? `${phaseLabel} ${p.page}/${p.pageCount}` : phaseLabel;
  })();

  const result = phase.kind === "done" || phase.kind === "degraded" ? phase.job.result : null;
  const pageSummary = (() => {
    const pr = result?.pageResults ?? [];
    const count = (s: string) => pr.filter((p) => p.status === s).length;
    return { ok: count("ok"), ocr: count("ocr"), scanned: count("scanned"), degraded: count("degraded") };
  })();
  const isMarkdownTarget = target === "md" || target === "mdx";
  const createdCount = result?.createdPaths?.length ?? 0;
  const imageCount = Math.max(createdCount - 1, 0);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t("pdfConvert:menu")}
          title={t("pdfConvert:menuHint")}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <FileText className="h-3.5 w-3.5" />
          {t("pdfConvert:menu")}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {sourceFormat === "pdf" && (
            <DropdownMenuItem onClick={() => openDialog("docx")}>
              {t("pdfConvert:toWord")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => openDialog("md")}>
            {t("pdfConvert:toMarkdown")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogTitle>
            {isMarkdownTarget ? t("pdfConvert:titleMarkdown") : t("pdfConvert:title")}
          </DialogTitle>

          {error && <div className="text-sm text-destructive">{error}</div>}

          {phase.kind === "plan" && (
            <div className="space-y-3 text-sm">
              {isMarkdownTarget && (
                <div className="space-y-1" role="radiogroup" aria-label={t("pdfConvert:formatLabel")}>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="convert-target"
                      checked={target === "md"}
                      onChange={() => switchTarget("md")}
                    />
                    {t("pdfConvert:formatMd")}
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="convert-target"
                      checked={target === "mdx"}
                      onChange={() => switchTarget("mdx")}
                    />
                    <span>
                      {t("pdfConvert:formatMdx")}
                      <span className="block text-xs text-muted-foreground">
                        {t("pdfConvert:formatMdxHint")}
                      </span>
                    </span>
                  </label>
                </div>
              )}
              {busy && !plan ? (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> {t("pdfConvert:loadingPlan")}
                </div>
              ) : plan ? (
                <>
                  <div>
                    <span className="text-muted-foreground">{t("pdfConvert:destination")}: </span>
                    <span className="font-medium">{plan.destinationVirtualPath}</span>
                  </div>
                  {plan.assetsVirtualPath && (
                    <div>
                      <span className="text-muted-foreground">{t("pdfConvert:assetsFolder")}: </span>
                      <span className="font-medium">{plan.assetsVirtualPath}</span>
                    </div>
                  )}
                  {plan.sourceFormat === "pdf" && (
                    <>
                      <div className="text-muted-foreground">
                        {t("pdfConvert:pageCount", { count: plan.pageCount })}
                        {plan.scannedPages.length > 0 &&
                          ` · ${t("pdfConvert:scannedPages", { count: plan.scannedPages.length })}`}
                      </div>
                      <div className="text-muted-foreground">
                        {plan.ocr.available
                          ? t("pdfConvert:ocrAvailable")
                          : t("pdfConvert:ocrUnavailable", {
                              reason: plan.ocr.reason ?? t("pdfConvert:ocrUnavailableReason"),
                            })}
                      </div>
                      {plan.ocr.available && plan.ocr.languages.length > 0 && (
                        <label className="flex items-center gap-2">
                          <span className="text-muted-foreground">{t("pdfConvert:language")}:</span>
                          <select
                            className="rounded-md border bg-background px-2 py-1 text-sm"
                            value={language}
                            onChange={(e) => setLanguage(e.target.value)}
                          >
                            <option value="">{t("pdfConvert:languageAuto")}</option>
                            {plan.ocr.languages.map((l) => (
                              <option key={l} value={l}>{l}</option>
                            ))}
                          </select>
                        </label>
                      )}
                    </>
                  )}
                  <div className="flex justify-end gap-2 pt-1">
                    <Button variant="outline" onClick={() => setOpen(false)}>
                      {t("common:actions.cancel")}
                    </Button>
                    <Button disabled={busy} onClick={() => void startConvert()}>
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : t("pdfConvert:start")}
                    </Button>
                  </div>
                </>
              ) : null}
            </div>
          )}

          {phase.kind === "running" && (
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {progressText ?? t("pdfConvert:working")}
              </div>
              <div className="flex justify-end">
                <Button variant="outline" onClick={cancelJob}>
                  {t("common:actions.cancel")}
                </Button>
              </div>
            </div>
          )}

          {phase.kind === "done" && result && (
            <div className="space-y-3 text-sm">
              {result.pageResults ? (
                <div>
                  {t("pdfConvert:doneSummary", {
                    ok: pageSummary.ok,
                    ocr: pageSummary.ocr,
                    scanned: pageSummary.scanned,
                  })}
                </div>
              ) : null}
              <div>
                {t("pdfConvert:doneFiles", { count: createdCount || 1 })}
                {imageCount > 0 && result.assetsVirtualPath
                  ? ` ${t("pdfConvert:doneImages", {
                      count: imageCount,
                      folder: result.assetsVirtualPath,
                    })}`
                  : null}
              </div>
              {result.degraded && (
                <div className="text-amber-600">{t("pdfConvert:degradedNote")}</div>
              )}
              {result.warnings && result.warnings.length > 0 && (
                <details className="text-muted-foreground">
                  <summary className="cursor-pointer">
                    {t("pdfConvert:warnings", { count: result.warnings.length })}
                  </summary>
                  <ul className="mt-1 list-disc pl-5 text-xs max-h-40 overflow-y-auto">
                    {result.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </details>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <Button variant="outline" onClick={() => setOpen(false)}>
                  {t("common:actions.close")}
                </Button>
                {result.virtualPath && (
                  <Button
                    onClick={() => {
                      setOpen(false);
                      onNavigate?.(result.virtualPath!);
                    }}
                  >
                    {t("pdfConvert:openDocument")}
                  </Button>
                )}
              </div>
            </div>
          )}

          {phase.kind === "degraded" && (
            <div className="space-y-3 text-sm">
              <div>{t("pdfConvert:degradedExplain")}</div>
              <div className="text-muted-foreground">
                {phase.job.error?.message}
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <Button variant="outline" onClick={() => setPhase({ kind: "plan" })}>
                  {t("common:actions.back")}
                </Button>
                <Button disabled={busy} onClick={() => void startConvert(true)}>
                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    t("pdfConvert:convertAnyway")
                  )}
                </Button>
              </div>
            </div>
          )}

          {phase.kind === "failed" && (
            <div className="space-y-3 text-sm">
              <div className="text-destructive">{phase.message}</div>
              <div className="flex justify-end">
                <Button variant="outline" onClick={() => setPhase({ kind: "plan" })}>
                  {t("common:actions.back")}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
