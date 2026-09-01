"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Check,
  Columns2,
  Download,
  Eye,
  Loader2,
  Pencil,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { common, createLowlight } from "lowlight";
import { toHtml } from "hast-util-to-html";
import { Button } from "@/components/ui/button";
import { SafeHtml } from "@/components/ui/safe-html";
import { ToolbarButton } from "@/components/layout/toolbar-button";
import { ViewerToolbar } from "@/components/layout/viewer-toolbar";
import { ViewerLayout } from "@/components/layout/viewer-layout";
import { NotebookOutputView } from "@/components/editor/notebook-output";
import { markdownToHtml } from "@/lib/markdown/to-html";
import {
  createNotebookCell,
  joinNotebookSource,
  moveNotebookCell,
  NotebookRevisionTracker,
  parseNotebook,
  replaceCellSource,
  serializeNotebook,
  type CodeCell,
  type MarkdownCell,
  type NotebookCell,
  type NotebookDocument,
} from "@/lib/notebook/model";

interface NotebookViewerProps {
  path: string;
  title: string;
}

type ViewMode = "preview" | "edit" | "split";
const lowlight = createLowlight(common);

function highlightCode(code: string, language: string): string {
  try {
    return toHtml(language ? lowlight.highlight(language, code) : lowlight.highlightAuto(code));
  } catch {
    return code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}

function MarkdownPreview({ cell }: { cell: MarkdownCell }) {
  const source = joinNotebookSource(cell.source);
  const [html, setHtml] = useState("");
  useEffect(() => {
    let active = true;
    void markdownToHtml(source).then((result) => {
      if (active) setHtml(result);
    });
    return () => { active = false; };
  }, [source]);
  return (
    <SafeHtml
      html={html}
      profile="rich"
      className="prose prose-sm max-w-none px-1 [&_h1]:font-serif [&_h2]:font-serif [&_h3]:font-serif"
    />
  );
}

function CodePreview({ cell, language }: { cell: CodeCell; language: string }) {
  const source = joinNotebookSource(cell.source);
  const html = useMemo(() => highlightCode(source, language), [source, language]);
  const count = cell.execution_count ?? " ";
  return (
    <div>
      <div className="grid grid-cols-[52px_1fr] gap-3">
        <div className="select-none pt-3 text-right font-mono text-[11px] text-primary/70">In&nbsp;[{count}]:</div>
        <pre className="overflow-x-auto whitespace-pre rounded-md border border-border bg-background px-4 py-3 font-mono text-[13px] leading-relaxed">
          <SafeHtml as="code" html={html} profile="code" />
        </pre>
      </div>
      {!!cell.outputs?.length && (
        <div className="mt-2 grid grid-cols-[52px_1fr] gap-3">
          <div className="select-none pt-3 text-right font-mono text-[11px] text-destructive/70">Out[{count}]:</div>
          <div className="space-y-2">
            {cell.outputs.map((output, index) => <NotebookOutputView key={index} output={output} />)}
          </div>
        </div>
      )}
    </div>
  );
}

function CellPreview({ cell, language }: { cell: NotebookCell; language: string }) {
  if (cell.cell_type === "markdown") return <MarkdownPreview cell={cell} />;
  if (cell.cell_type === "code") return <CodePreview cell={cell} language={language} />;
  return <pre className="whitespace-pre-wrap rounded-md bg-muted px-4 py-3 font-mono text-[12.5px]">{joinNotebookSource(cell.source)}</pre>;
}

function CellEditor({ cell, onChange }: { cell: NotebookCell; onChange: (source: string) => void }) {
  return (
    <textarea
      value={joinNotebookSource(cell.source)}
      onChange={(event) => onChange(event.target.value)}
      rows={Math.max(4, Math.min(18, joinNotebookSource(cell.source).split("\n").length + 1))}
      spellCheck={cell.cell_type === "markdown"}
      aria-label={`Edit ${cell.cell_type} cell`}
      className="min-h-28 w-full resize-y rounded-md border border-border bg-background px-4 py-3 font-mono text-[13px] leading-relaxed outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
    />
  );
}

function NotebookCellView({
  cell,
  index,
  count,
  language,
  mode,
  onSourceChange,
  onMove,
  onDelete,
}: {
  cell: NotebookCell;
  index: number;
  count: number;
  language: string;
  mode: ViewMode;
  onSourceChange: (source: string) => void;
  onMove: (to: number) => void;
  onDelete: () => void;
}) {
  const editable = mode !== "preview";
  return (
    <section className="group relative rounded-lg border border-transparent px-2 py-3 hover:border-border/70 hover:bg-background/40" data-cell-index={index}>
      {editable && (
        <div className="mb-2 flex items-center justify-between">
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{cell.cell_type}</span>
          <div className="flex items-center gap-0.5">
            <Button variant="ghost" size="icon-xs" onClick={() => onMove(index - 1)} disabled={index === 0} aria-label="Move cell up"><ArrowUp /></Button>
            <Button variant="ghost" size="icon-xs" onClick={() => onMove(index + 1)} disabled={index === count - 1} aria-label="Move cell down"><ArrowDown /></Button>
            <Button variant="ghost" size="icon-xs" className="text-destructive" onClick={onDelete} aria-label="Delete cell"><Trash2 /></Button>
          </div>
        </div>
      )}
      {mode === "preview" ? (
        <CellPreview cell={cell} language={language} />
      ) : mode === "edit" ? (
        <CellEditor cell={cell} onChange={onSourceChange} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <CellEditor cell={cell} onChange={onSourceChange} />
          <div className="min-w-0 rounded-md border border-border/60 bg-background/60 p-3">
            <CellPreview cell={cell} language={language} />
          </div>
        </div>
      )}
    </section>
  );
}

export function NotebookViewer({ path }: NotebookViewerProps) {
  const [notebook, setNotebook] = useState<NotebookDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>("preview");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const revisionRef = useRef(new NotebookRevisionTracker());
  const saveInFlightRef = useRef(false);

  const assetUrl = `/api/assets/${path}`;
  const filename = path.split("/").pop() || path;

  const fetchNotebook = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(assetUrl, { cache: "no-store" });
      if (!response.ok) throw new Error(`Could not load notebook (HTTP ${response.status})`);
      setNotebook(parseNotebook(await response.json()));
      // Loading a document also advances the generation so a save response from
      // the previously viewed path cannot mark this notebook clean.
      revisionRef.current.changed();
      setDirty(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load notebook");
    } finally {
      setLoading(false);
    }
  }, [assetUrl]);

  useEffect(() => { void fetchNotebook(); }, [fetchNotebook]);

  const saveNotebook = useCallback(async () => {
    if (!notebook || saveInFlightRef.current) return;
    const savedRevision = revisionRef.current.current();
    const snapshot = serializeNotebook(notebook);
    saveInFlightRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(assetUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: snapshot,
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(detail?.error || `Could not save notebook (HTTP ${response.status})`);
      }
      // An edit made while this request was pending belongs to a newer revision.
      // Never let an older save response clear that edit's dirty indicator.
      if (revisionRef.current.isCurrent(savedRevision)) {
        setDirty(false);
        setSaved(true);
        window.setTimeout(() => setSaved(false), 1800);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to save notebook");
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  }, [assetUrl, notebook]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveNotebook();
      }
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [dirty, saveNotebook]);

  const updateCells = useCallback((update: (cells: NotebookCell[]) => NotebookCell[]) => {
    setNotebook((current) => current ? { ...current, cells: update(current.cells) } : current);
    revisionRef.current.changed();
    setDirty(true);
    setSaved(false);
  }, []);

  const language = String(
    notebook?.metadata.language_info?.name || notebook?.metadata.kernelspec?.name || "python"
  );
  const cells = notebook?.cells ?? [];
  const codeCellCount = cells.filter((cell) => cell.cell_type === "code").length;

  const addCell = (cellType: NotebookCell["cell_type"]) => {
    updateCells((current) => [...current, createNotebookCell(cellType)]);
    setMode((current) => current === "preview" ? "edit" : current);
  };

  return (
    <ViewerLayout
      toolbar={
        <ViewerToolbar path={path} badge="IPYNB" sublabel={`${cells.length} cells · ${codeCellCount} code · ${language}`}>
          <div className="mr-1 inline-flex items-center rounded-md border border-border p-0.5">
            <ToolbarButton icon={Eye} label="Preview" iconOnly active={mode === "preview"} onClick={() => setMode("preview")} />
            <ToolbarButton icon={Pencil} label="Edit" iconOnly active={mode === "edit"} onClick={() => setMode("edit")} />
            <ToolbarButton icon={Columns2} label="Split preview" iconOnly active={mode === "split"} onClick={() => setMode("split")} />
          </div>
          <ToolbarButton icon={Plus} label="Add code" onClick={() => addCell("code")} />
          <ToolbarButton icon={saving ? Loader2 : saved ? Check : Save} label={saving ? "Saving" : saved ? "Saved" : dirty ? "Save changes" : "Saved"} disabled={!dirty || saving} onClick={() => void saveNotebook()} className={saving ? "[&_svg]:animate-spin" : undefined} />
          <ToolbarButton icon={Download} label="Download" iconOnly href={assetUrl} download={filename} />
        </ViewerToolbar>
      }
    >
      <div className="flex-1 overflow-auto bg-muted/30">
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Loading notebook...</div>
        ) : !notebook ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" />{error}</div>
        ) : (
          <div className={`mx-auto px-4 py-6 ${mode === "split" ? "max-w-[1500px]" : "max-w-[1100px]"}`}>
            {error && <div role="alert" className="mb-4 flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" />{error}</div>}
            {cells.map((cell, index) => (
              <NotebookCellView
                key={cell.id ?? index}
                cell={cell}
                index={index}
                count={cells.length}
                language={language}
                mode={mode}
                onSourceChange={(source) => updateCells((current) => current.map((item, itemIndex) => itemIndex === index ? replaceCellSource(item, source) : item))}
                onMove={(to) => updateCells((current) => moveNotebookCell(current, index, to))}
                onDelete={() => updateCells((current) => current.filter((_, itemIndex) => itemIndex !== index))}
              />
            ))}
            {mode !== "preview" && (
              <div className="mt-4 flex items-center justify-center gap-2 border-t border-dashed border-border pt-5">
                <Button variant="outline" size="sm" onClick={() => addCell("code")}><Plus />Code</Button>
                <Button variant="outline" size="sm" onClick={() => addCell("markdown")}><Plus />Markdown</Button>
                <Button variant="outline" size="sm" onClick={() => addCell("raw")}><Plus />Raw</Button>
              </div>
            )}
          </div>
        )}
      </div>
    </ViewerLayout>
  );
}
