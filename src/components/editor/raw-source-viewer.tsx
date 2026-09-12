/* eslint-disable @next/next/no-img-element -- Receipt-verified local data URLs bypass the image optimization endpoint. */
"use client";
import { useEffect, useState, useRef, type ReactNode } from "react";
import { BookOpen, FileText, Code2, Download, LockKeyhole } from "lucide-react";
import type { RawReaderResult } from "@/lib/llm-wiki/reader-types";
import type { SourceViewMode } from "@/lib/llm-wiki/types";
import "./raw-source-viewer.css";

export function RawSourceBoundary({ path, children }: { path: string; children: ReactNode }) {
  const [result, setResult] = useState<{ path: string; data?: RawReaderResult; error?: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/llm-wiki/reader?path=${encodeURIComponent(path)}`, { signal: controller.signal })
      .then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.error); return data as RawReaderResult; })
      .then((data) => setResult({ path, data }))
      .catch((error) => { if (!controller.signal.aborted) setResult({ path, error: String(error.message ?? error) }); });
    return () => controller.abort();
  }, [path]);
  if (result?.path !== path) return <div className="p-8 text-sm text-muted-foreground" role="status">Loading source…</div>;
  if (result.error) return <div className="p-8" role="alert">{result.error}</div>;
  const data = result.data!;
  if (data.kind === "file") return <section className="flex min-h-0 flex-1 flex-col overflow-auto p-6" aria-label="Captured file"><h1 className="text-xl font-semibold">{data.title}</h1><p className="my-2 text-xs text-muted-foreground">Read-only captured file</p>{data.download && <a className="mb-4 underline" href={data.download} download>Download file</a>}{data.text !== undefined ? <pre className="whitespace-pre-wrap break-words rounded border p-4 text-sm">{data.text}</pre> : data.image ? <img src={data.image} alt={data.title} className="max-w-full object-contain" /> : <p>Use Download file to open this format.</p>}</section>;
  if (data.kind === "ordinary") return <>{(data.capturePath || data.pending) && <div className="border-b border-border px-6 py-2 text-sm">{data.capturePath ? <a className="underline" href={`/room/${data.capturePath.split("/").map(encodeURIComponent).join("/")}`}>Read captured source (Reader / Original / Markdown)</a> : "Wiki source registered. Capture pending."}</div>}{children}</>;
  if (data.kind === "directory") return <section className="p-8"><h1 className="text-2xl font-semibold">Sources</h1><p className="mt-2 text-sm text-muted-foreground">Captured evidence, preserved for reference.</p>
    <ul className="mt-6 divide-y divide-border">{data.sources.map((source) => <li key={source.id} className="py-4"><a className="font-medium hover:underline" href={`/room/${source.path.split("/").map(encodeURIComponent).join("/")}`}>{source.title}</a><span className="ml-3 text-xs text-muted-foreground">{source.status}</span></li>)}</ul>
    {!data.sources.length && <p className="mt-6 text-sm text-muted-foreground">No captured Sources here yet.</p>}</section>;
  return <RawSourceViewer key={`${data.sourceId}:${data.versionId}`} data={data} />;
}

export function RawSourceViewer({ data: initialData }: { data: Extract<RawReaderResult, { kind: "source" }> }) {
  const [data, setData] = useState(initialData);
  const [loadingVersion, setLoadingVersion] = useState<string | null>(null);
  const [versionError, setVersionError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const chooseVersion = async (id: string) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoadingVersion(id); setVersionError(null);
    try {
      const response = await fetch(`/api/llm-wiki/reader?path=${encodeURIComponent(data.sourcePath)}&version=${encodeURIComponent(id)}`, { signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Unable to load this version.");
      if (result.kind !== "source" || result.sourceId !== data.sourceId || result.versionId !== id) throw new Error("The selected version could not be verified.");
      if (!controller.signal.aborted) { setData(result); setLoadingVersion(null); }
    } catch (error) {
      if (!controller.signal.aborted) { setVersionError(error instanceof Error ? error.message : "Unable to load this version."); setLoadingVersion(null); }
    }
  };
  const preference = `cabinet.raw-view.${data.cabinetId}.${data.sourceId}`;
  const [view, setView] = useState<SourceViewMode>(() => {
    try { const value = localStorage.getItem(preference); if (value === "reader" || value === "original" || value === "markdown") return value; } catch { /* Storage is optional. */ }
    return "reader";
  });
  const select = (next: SourceViewMode) => { setView(next); try { localStorage.setItem(preference, next); } catch { /* Storage is optional. */ } };
  const fileUrl = `/api/llm-wiki/reader?source=${data.sourceId}&version=${data.versionId}&file=original.${data.format}`;
  const options = [{ value: "reader" as const, label: "Reader", icon: BookOpen }, { value: "original" as const, label: "Original", icon: FileText }, { value: "markdown" as const, label: "Markdown", icon: Code2 }];
  return <section className="flex min-h-0 flex-1 flex-col overflow-hidden" aria-label="Captured source">
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-6 py-4">
      <div className="min-w-0"><h1 className="truncate text-xl font-semibold">{data.title}</h1><p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground"><LockKeyhole className="h-3 w-3" />Captured version {data.version}<span>·</span>{data.filename}{data.status !== "active" && <span>· {data.status === "deleted" ? "Removed from active knowledge" : "Archived"}</span>}</p></div>
      <div className="flex flex-wrap items-center gap-3">
        {data.versions.length > 1 && <label className="flex items-center gap-2 text-xs text-muted-foreground">Version
          <select aria-label="Source version" value={loadingVersion ?? data.versionId} onChange={(event) => void chooseVersion(event.target.value)}
            className="max-w-full rounded-md border border-border bg-background px-2 py-2 text-sm text-foreground">
            {data.versions.map((item) => <option key={item.id} value={item.id}>v{item.version} · {item.status === "current" ? "Current" : "Superseded"} · {new Date(item.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</option>)}
          </select>
        </label>}
        {loadingVersion ? <span className="text-xs text-muted-foreground" role="status">Loading version…</span> : <a className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs hover:bg-accent" href={fileUrl} download><Download className="h-3.5 w-3.5" />Download original</a>}
      </div>
    </header>
    <div className="flex items-center justify-between gap-3 px-6 py-3"><div role="tablist" aria-label="Source view" className="inline-flex rounded-lg bg-muted p-1">{options.map(({ value, label, icon: Icon }, index) => <button key={value} type="button" id={`raw-tab-${value}`} role="tab" aria-selected={view === value} aria-controls="raw-source-panel" tabIndex={view === value ? 0 : -1}
      onClick={() => select(value)} onKeyDown={(event) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? 2 : (index + (event.key === "ArrowRight" ? 1 : 2)) % 3; select(options[next].value); document.getElementById(`raw-tab-${options[next].value}`)?.focus(); } }}
      className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm ${view === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}><Icon className="h-3.5 w-3.5" />{label}</button>)}</div><span className="text-xs text-muted-foreground">Read-only</span></div>
    {versionError && <p role="alert" className="px-6 pb-3 text-sm text-destructive">{versionError} The previous version is still displayed.</p>}
    <div id="raw-source-panel" aria-busy={loadingVersion !== null} role="tabpanel" aria-labelledby={`raw-tab-${view}`} className="min-h-0 flex-1 overflow-auto" tabIndex={0}>
      {!loadingVersion && view === "reader" && <article className="raw-reader mx-auto max-w-3xl px-8 py-6" dangerouslySetInnerHTML={{ __html: data.readerHtml }} />}
      {!loadingVersion && view === "markdown" && <pre className="m-6 whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/30 p-5 font-mono text-sm leading-6">{data.markdown}</pre>}
      {!loadingVersion && view === "original" && <>
        {data.original.kind === "html" && <><p className="px-6 pb-3 text-xs text-muted-foreground">Safe preview. Scripts, external resources and navigation are disabled.</p><iframe title={data.format === "ipynb" ? "Original notebook preview" : "Original HTML preview"} sandbox="" referrerPolicy="no-referrer" srcDoc={data.original.content} className="h-[70vh] w-full border-0 bg-white" /></>}
        {data.original.kind === "text" && <pre className="m-6 whitespace-pre-wrap break-words rounded-lg border border-border p-5 font-mono text-sm leading-6">{data.original.content}</pre>}
        {data.original.kind === "pdf" && <><p className="px-6 pb-3 text-xs text-muted-foreground">If your browser cannot display this PDF, use Download original.</p><iframe title="Original PDF preview" sandbox="allow-scripts" referrerPolicy="no-referrer" src={`${fileUrl}&inline=1`} className="h-[70vh] w-full border-0" /></>}
        {data.original.kind === "download" && <div className="mx-auto max-w-lg p-12 text-center"><FileText className="mx-auto mb-4 h-10 w-10 text-muted-foreground" /><h2 className="font-semibold">Original available to download</h2><p className="mt-2 text-sm text-muted-foreground">This file has no built-in preview. Read its captured content in Reader or download the original.</p></div>}
      </>}
    </div>
  </section>;
}
