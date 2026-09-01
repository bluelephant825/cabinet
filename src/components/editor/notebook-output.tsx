"use client";

import { useEffect, useMemo, useState } from "react";
import katex from "katex";
import { markdownToHtml } from "@/lib/markdown/to-html";
import { SafeHtml } from "@/components/ui/safe-html";
import {
  joinNotebookSource,
  type DataOutput,
  type ErrorOutput,
  type NotebookMimeValue,
  type NotebookOutput,
  type StreamOutput,
} from "@/lib/notebook/model";

export const NOTEBOOK_HTML_SANDBOX = "";

export function notebookMimeText(value: NotebookMimeValue): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((part) => typeof part === "string")) {
    return value.join("");
  }
  return "";
}

export function formatNotebookJson(value: NotebookMimeValue): string {
  let structured = value;
  if (typeof value === "string") {
    try {
      structured = JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(structured, null, 2) ?? "null";
  } catch {
    return "Unable to display JSON output";
  }
}

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, "");
}

function StreamOutputView({ output }: { output: StreamOutput }) {
  const isError = output.name === "stderr";
  return (
    <pre className={`whitespace-pre-wrap rounded-md px-4 py-3 font-mono text-[12.5px] leading-relaxed ${
      isError ? "bg-destructive/10 text-destructive" : "bg-muted text-foreground"
    }`}>
      {stripAnsi(joinNotebookSource(output.text))}
    </pre>
  );
}

function ErrorOutputView({ output }: { output: ErrorOutput }) {
  const traceback = (output.traceback ?? []).map(stripAnsi).join("\n");
  return (
    <pre className="whitespace-pre-wrap rounded-md border border-destructive/20 bg-destructive/10 px-4 py-3 font-mono text-[12.5px] leading-relaxed text-destructive">
      <span className="font-semibold">{output.ename}: {output.evalue}</span>
      {traceback ? `\n\n${traceback}` : ""}
    </pre>
  );
}

function MarkdownOutput({ source }: { source: string }) {
  const [html, setHtml] = useState("");
  useEffect(() => {
    let active = true;
    void markdownToHtml(source).then((result) => {
      if (active) setHtml(result);
    });
    return () => { active = false; };
  }, [source]);
  return <SafeHtml html={html} profile="rich" className="prose prose-sm max-w-none" />;
}

function LatexOutput({ source }: { source: string }) {
  const html = useMemo(() => katex.renderToString(source, {
    displayMode: true,
    throwOnError: false,
    strict: false,
  }), [source]);
  return <SafeHtml html={html} profile="rich" className="overflow-x-auto py-2" />;
}

function DataOutputView({ output }: { output: DataOutput }) {
  const data = output.data ?? {};
  if (data["image/png"] || data["image/jpeg"]) {
    const mime = data["image/png"] ? "image/png" : "image/jpeg";
    const payload = notebookMimeText(data[mime]).replace(/\s/g, "");
    return <img src={`data:${mime};base64,${payload}`} alt="Notebook output" className="max-w-full rounded-md bg-white p-2" />;
  }
  if (data["image/svg+xml"]) {
    return <SafeHtml html={notebookMimeText(data["image/svg+xml"])} profile="svg" className="max-w-full overflow-auto rounded-md bg-white p-2" />;
  }
  if (data["text/html"]) {
    const html = notebookMimeText(data["text/html"]);
    return (
      <iframe
        srcDoc={`<!doctype html><html><head><base target="_blank"><style>body{margin:0;padding:8px;font-family:Inter,system-ui,sans-serif;color:#2a221b;font-size:13px}table{border-collapse:collapse}th,td{border:1px solid #d4c4b0;padding:4px 8px;text-align:left}</style></head><body>${html}</body></html>`}
        sandbox={NOTEBOOK_HTML_SANDBOX}
        title="Notebook HTML output"
        className="h-[360px] w-full rounded-md border border-border bg-white"
      />
    );
  }
  if (data["text/latex"]) return <LatexOutput source={notebookMimeText(data["text/latex"])} />;
  if (data["text/markdown"]) return <MarkdownOutput source={notebookMimeText(data["text/markdown"])} />;
  const jsonMime = Object.keys(data).find((mime) => mime === "application/json" || /^application\/[\w.+-]+\+json$/i.test(mime));
  if (jsonMime) {
    return <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted px-4 py-3 font-mono text-[12.5px]">{formatNotebookJson(data[jsonMime])}</pre>;
  }
  if (data["text/plain"]) {
    return <pre className="whitespace-pre-wrap rounded-md bg-muted px-4 py-3 font-mono text-[12.5px] leading-relaxed">{stripAnsi(notebookMimeText(data["text/plain"]))}</pre>;
  }
  return null;
}

export function NotebookOutputView({ output }: { output: NotebookOutput }) {
  if (output.output_type === "stream") return <StreamOutputView output={output as StreamOutput} />;
  if (output.output_type === "error") return <ErrorOutputView output={output as ErrorOutput} />;
  if (output.output_type === "execute_result" || output.output_type === "display_data") {
    return <DataOutputView output={output as DataOutput} />;
  }
  return null;
}
