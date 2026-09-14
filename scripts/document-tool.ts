#!/usr/bin/env node
/**
 * `cabinet-documents` — agent-facing CLI for the Cabinet document service.
 *
 * Talks to the local daemon over loopback HTTP with the shared daemon token
 * (read from its 0600 file — never printed, never taken as an arg). Every
 * command prints one JSON value to stdout; failures print
 * `{ "error": { code, message, details? } }` and exit non-zero.
 *
 * Actor: requests carry `{ kind: "agent", id: $CABINET_AGENT_SLUG || "agent",
 * runId: $CABINET_RUN_ID }` so the daemon can attribute history to the run.
 *
 * Dev: `npx tsx scripts/document-tool.ts <cmd>` — the packaged shim execs the
 * bundled dist/document-tool.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import { getDaemonUrl, getOrCreateDaemonTokenSync } from "@/lib/agents/daemon-auth";
import { DATA_DIR, virtualPathFromFs } from "@/lib/storage/path-utils";
import type {
  DocumentActor,
  DocumentPatchOp,
  DocxSavePlan,
  JobInfo,
} from "@/lib/documents/types";
import blankTemplate from "../src/lib/documents/pdf-templates/blank.json";
import invoiceTemplate from "../src/lib/documents/pdf-templates/invoice.json";
import reportTemplate from "../src/lib/documents/pdf-templates/report.json";

const PDF_TEMPLATES: Record<string, unknown> = {
  blank: blankTemplate,
  invoice: invoiceTemplate,
  report: reportTemplate,
};

// ── plumbing ─────────────────────────────────────────────────────────────

interface ToolErrorShape {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

function actor(): DocumentActor {
  const slug = process.env.CABINET_AGENT_SLUG?.trim() || "agent";
  const runId = process.env.CABINET_RUN_ID?.trim() || undefined;
  return { kind: "agent", id: slug, runId };
}

async function api(op: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
  const token = getOrCreateDaemonTokenSync();
  let res: Response;
  try {
    res = await fetch(`${getDaemonUrl()}/documents/${op}`, {
      method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
      headers: {
        authorization: `Bearer ${token}`,
        ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ToolError(
      "daemon-unreachable",
      `Could not reach the Cabinet daemon at ${getDaemonUrl()} — is it running?`,
    );
  }
  const text = await res.text();
  let json: unknown = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON body — handled below */
  }
  if (!res.ok) {
    const payload = json as { error?: string; code?: string; details?: Record<string, unknown> };
    throw new ToolError(
      payload.code ?? "request-failed",
      payload.error ?? `HTTP ${res.status}`,
      payload.details,
    );
  }
  return json;
}

/** Resolve --path to a cabinet virtual path. Absolute or cwd-relative fs
    paths are mapped through DATA_DIR; anything else is treated as a virtual
    path already (agents run with cwd inside the data dir). */
function resolveVirtualPath(arg: string): string {
  const cleaned = arg.trim();
  if (!cleaned) throw new ToolError("invalid", "--path is required");
  const abs = path.isAbsolute(cleaned)
    ? path.normalize(cleaned)
    : path.resolve(process.cwd(), cleaned);
  const rel = path.relative(path.resolve(DATA_DIR), abs);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
    return virtualPathFromFs(abs);
  }
  if (path.isAbsolute(cleaned)) {
    throw new ToolError("invalid", `Path is outside the cabinet data directory`);
  }
  // cwd is outside DATA_DIR — take the arg at face value as a virtual path.
  return cleaned.replace(/^\/+/, "");
}

function readJsonArg(value: string, what: string): unknown {
  const raw = value.startsWith("@")
    ? fs.readFileSync(value.slice(1), "utf8")
    : value;
  try {
    return JSON.parse(raw);
  } catch {
    throw new ToolError("invalid", `${what} is not valid JSON`);
  }
}

/** Never emit absolute host paths or the daemon token to the agent. */
function sanitize(value: unknown): unknown {
  const dataDir = path.resolve(DATA_DIR);
  const token = (() => {
    try {
      return getOrCreateDaemonTokenSync();
    } catch {
      return "";
    }
  })();
  const scrub = (v: unknown): unknown => {
    if (typeof v === "string") {
      let out = v.split(dataDir).join("<data>");
      if (token) out = out.split(token).join("<redacted>");
      return out;
    }
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, scrub(val)]),
      );
    }
    return v;
  };
  return scrub(value);
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(sanitize(value), null, 2)}\n`);
}

function fail(err: unknown): never {
  const shape: ToolErrorShape =
    err instanceof ToolError
      ? { code: err.code, message: err.message, details: err.details }
      : { code: "internal", message: err instanceof Error ? err.message : String(err) };
  process.stdout.write(`${JSON.stringify({ error: sanitize(shape) }, null, 2)}\n`);
  process.exit(1);
}

// ── session helpers ──────────────────────────────────────────────────────

async function withSession<T>(
  virtualPath: string,
  fn: (session: { sessionId: string; revision: string }) => Promise<T>,
): Promise<T> {
  const opened = (await api("open", {
    body: { virtualPath, actor: actor() },
  })) as { sessionId: string; revision: string };
  try {
    return await fn(opened);
  } finally {
    await api("close", { body: { sessionId: opened.sessionId } }).catch(() => {});
  }
}

// ── args ─────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { flags: Map<string, string>; bools: Set<string> } {
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      throw new ToolError("invalid", `Unexpected argument: ${a}`);
    }
    const eq = a.indexOf("=");
    if (eq >= 0) {
      flags.set(a.slice(2, eq), a.slice(eq + 1));
      continue;
    }
    const name = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i++;
    } else {
      bools.add(name);
    }
  }
  return { flags, bools };
}

function requiredPath(flags: Map<string, string>): string {
  const p = flags.get("path");
  if (!p) throw new ToolError("invalid", "--path <virtualPath> is required");
  return resolveVirtualPath(p);
}

// ── help ─────────────────────────────────────────────────────────────────

const HELP = `cabinet-documents — read, edit, and convert Cabinet .docx/.pdf documents.

Paths: --path takes a cabinet virtual path (e.g. "notes/report.docx") or a
relative/absolute filesystem path inside the cabinet — relative paths resolve
against your current working directory.

Commands:
  inspect    --path                          Structure: docx paragraphs (stable ids), pdf pages/lines
  read       --path [--page N | --paragraphs A-B]
                                             Text content (whole doc, one page, or paragraph range)
  search     --path --query TEXT             Matches with locations/snippets
  geometry   --path [--pages 1,2]            PDF page geometry: editable text lines + images
  patch      --path --ops <json|@file> [--base-revision R]
                                             Apply edit ops; all-or-nothing, conflict-checked.
                                             Without --base-revision the current revision is used.
  docx-load  --path                          Full structured DOCX model (blocks/sections/styles)
  docx-save  --path --plan <json|@file> [--base-revision R]
                                             Save a structured save plan (from docx-load / edit host)
  convert    --path [--to docx|md|mdx] [--dest path] [--lang en,fr] [--acknowledge-degraded] [--wait]
                                             PDF -> DOCX (default) or PDF/DOCX -> Markdown/MDX as a
                                             job; --wait polls to completion
  job        --id JOB                        Job status/result
  cancel     --id JOB                        Cancel a running job
  ocr-capabilities                           OCR provider availability + languages on this host
  recovery   --path                          List recovery copies for a document
  revision   --path                          Current revision token (for --base-revision)

PDF generation (compositions live as <name>.pdf.source.json text files):
  pdf-new    --path <name>.pdf.source.json --template blank|invoice|report [--title T]
                                             Create a composition source (validated server-side)
  pdf-validate --path                        Validate a composition source against the catalog
  pdf-catalog                                Component/theme catalog (types, props, parents)
  pdf-render --path [--publish [--replace | --copy]] [--wait]
                                             preview (default) returns { previewKey }; --publish
                                             commits <name>.pdf. A hand-modified output conflicts
                                             unless --replace (overwrite) or --copy (new file).
  pdf-status --path                          { sourceRevision, output?: { stale, modified } }

Patch ops (--ops is a JSON array; one example per kind):
  [{"kind":"replaceParagraphText","paragraphId":"p3","expectedText":"old","newText":"new"}]
  [{"kind":"pdfTextEdit","edit":{"pageIndex":0,"rect":[x0,y0,x1,y1],"oldText":"a","newText":"b","fontSize":12}}]
  [{"kind":"pdfTextInsert","insert":{"pageIndex":0,"origin":[x,y],"text":"hi","fontSize":12,"color":[0,0,0]}}]
  [{"kind":"pdfImageOp","op":{"kind":"deleteImage","pageIndex":0,"oldRect":[x0,y0,x1,y1]}}]

Notes:
  - Paragraph/line/image ids come from inspect/geometry on the CURRENT revision.
  - Edits are revision-checked: a "conflict" error means re-inspect and retry.
  - convert creates a NEW file next to the source (or under --dest): .docx for
    --to docx, .md/.mdx for --to md/mdx. Markdown outputs carry a "source"
    frontmatter key pointing back at the source document; extracted images go
    to a sibling "<stem>-assets/" folder referenced as "./<stem>-assets/<file>".
    Per-page results report ok / ocr / scanned / degraded (PDF sources).
    Report every path in createdPaths to the user.
`;

// ── main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(HELP);
    return;
  }
  const { flags, bools } = parseArgs(rest);

  switch (cmd) {
    case "inspect": {
      const virtualPath = requiredPath(flags);
      return print(await api("inspect", { body: { virtualPath, actor: actor() } }));
    }
    case "read": {
      const virtualPath = requiredPath(flags);
      const body: Record<string, unknown> = { virtualPath, actor: actor() };
      if (flags.get("page")) body.page = Number(flags.get("page"));
      if (flags.get("paragraphs")) {
        const m = flags.get("paragraphs")!.match(/^(\d+)\s*-\s*(\d+)$/);
        if (!m) throw new ToolError("invalid", "--paragraphs expects A-B (e.g. 0-5)");
        body.paragraphRange = [Number(m[1]), Number(m[2])];
      }
      return print(await api("read", { body }));
    }
    case "search": {
      const virtualPath = requiredPath(flags);
      const query = flags.get("query");
      if (!query) throw new ToolError("invalid", "--query is required");
      return print(await api("search", { body: { virtualPath, query, actor: actor() } }));
    }
    case "geometry": {
      const virtualPath = requiredPath(flags);
      const body: Record<string, unknown> = { virtualPath, actor: actor() };
      if (flags.get("pages")) {
        // Input is 1-based page numbers; the API wants 0-based indexes.
        body.pages = flags
          .get("pages")!
          .split(",")
          .map((s) => Number(s.trim()) - 1)
          .filter((n) => Number.isInteger(n) && n >= 0);
      }
      return print(await api("pdf/geometry", { body }));
    }
    case "patch": {
      const virtualPath = requiredPath(flags);
      const opsArg = flags.get("ops");
      if (!opsArg) throw new ToolError("invalid", "--ops <json|@file> is required");
      const ops = readJsonArg(opsArg, "--ops") as DocumentPatchOp[];
      if (!Array.isArray(ops) || ops.length === 0) {
        throw new ToolError("invalid", "--ops must be a non-empty JSON array");
      }
      const result = await withSession(virtualPath, async (session) => {
        return api("patch", {
          body: {
            sessionId: session.sessionId,
            baseRevision: flags.get("base-revision") ?? session.revision,
            ops,
            actor: actor(),
          },
        });
      });
      return print(result);
    }
    case "docx-load": {
      const virtualPath = requiredPath(flags);
      const result = await withSession(virtualPath, (session) =>
        api("docx/load", { body: { sessionId: session.sessionId } }),
      );
      return print(result);
    }
    case "docx-save": {
      const virtualPath = requiredPath(flags);
      const planArg = flags.get("plan");
      if (!planArg) throw new ToolError("invalid", "--plan <json|@file> is required");
      const plan = readJsonArg(planArg, "--plan") as DocxSavePlan;
      const result = await withSession(virtualPath, async (session) =>
        api("docx/save", {
          body: {
            sessionId: session.sessionId,
            baseRevision: flags.get("base-revision") ?? session.revision,
            plan,
            actor: actor(),
          },
        }),
      );
      return print(result);
    }
    case "convert": {
      const virtualPath = requiredPath(flags);
      const { revision } = (await api("revision", {
        body: { virtualPath },
      })) as { revision: string };
      const body: Record<string, unknown> = {
        virtualPath,
        baseRevision: flags.get("base-revision") ?? revision,
        actor: actor(),
      };
      const to = flags.get("to") ?? "docx";
      if (!["docx", "md", "mdx"].includes(to)) {
        throw new ToolError("invalid", `--to must be one of docx|md|mdx (got '${to}')`);
      }
      body.target = to;
      if (flags.get("dest")) body.destinationVirtualPath = resolveVirtualPath(flags.get("dest")!);
      if (flags.get("lang")) {
        body.languageHints = flags.get("lang")!.split(",").map((s) => s.trim()).filter(Boolean);
      }
      if (bools.has("acknowledge-degraded")) body.acknowledgeDegraded = true;
      const started = (await api("convert", { body })) as { jobId: string };
      if (!bools.has("wait")) return print(started);
      const job = await waitForJob(started.jobId);
      if (job.status === "failed") {
        throw new ToolError(job.error?.code ?? "failed", job.error?.message ?? "Job failed", job.error?.details);
      }
      if (job.status === "cancelled") {
        throw new ToolError("cancelled", "Job was cancelled");
      }
      return print(job.result ?? job);
    }
    case "job": {
      const id = flags.get("id");
      if (!id) throw new ToolError("invalid", "--id is required");
      return print(await api(`jobs/${encodeURIComponent(id)}`));
    }
    case "cancel": {
      const id = flags.get("id");
      if (!id) throw new ToolError("invalid", "--id is required");
      return print(await api(`jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" }));
    }
    case "pdf-catalog": {
      return print(await api("pdf-composition/catalog"));
    }
    case "pdf-validate": {
      const virtualPath = requiredPath(flags);
      return print(
        await api("pdf-composition/validate", { body: { virtualPath } }),
      );
    }
    case "pdf-status": {
      const virtualPath = requiredPath(flags);
      return print(
        await api(`pdf-composition/status?path=${encodeURIComponent(virtualPath)}`),
      );
    }
    case "pdf-new": {
      const virtualPath = requiredPath(flags);
      if (!virtualPath.endsWith(".pdf.source.json")) {
        throw new ToolError("invalid", "--path must end in .pdf.source.json");
      }
      const templateName = flags.get("template") ?? "blank";
      const template = PDF_TEMPLATES[templateName];
      if (!template) {
        throw new ToolError(
          "invalid",
          `Unknown template '${templateName}' — expected blank|invoice|report`,
        );
      }
      const composition = JSON.parse(JSON.stringify(template)) as Record<string, unknown>;
      if (flags.get("title")) composition.title = flags.get("title")!;
      const body: Record<string, unknown> = {
        virtualPath,
        composition,
        actor: actor(),
      };
      if (flags.get("base-revision")) body.baseRevision = flags.get("base-revision");
      return print(await api("pdf-composition/source", { body }));
    }
    case "pdf-render": {
      const virtualPath = requiredPath(flags);
      const body: Record<string, unknown> = {
        sourceVirtualPath: virtualPath,
        mode: bools.has("publish") ? "publish" : "preview",
        actor: actor(),
      };
      if (bools.has("replace")) body.replace = true;
      if (bools.has("copy")) body.saveAsCopy = true;
      if (flags.get("dest")) body.destinationVirtualPath = resolveVirtualPath(flags.get("dest")!);
      const started = (await api("pdf-composition/render", { body })) as { jobId: string };
      if (!bools.has("wait")) return print(started);
      const job = await waitForJob(started.jobId);
      if (job.status === "failed") {
        throw new ToolError(job.error?.code ?? "failed", job.error?.message ?? "Job failed", job.error?.details);
      }
      if (job.status === "cancelled") {
        throw new ToolError("cancelled", "Job was cancelled");
      }
      return print(job.result ?? job);
    }
    case "ocr-capabilities": {
      return print(await api("ocr/capabilities"));
    }
    case "recovery": {
      const virtualPath = requiredPath(flags);
      return print(await api(`recovery?path=${encodeURIComponent(virtualPath)}`));
    }
    case "revision": {
      const virtualPath = requiredPath(flags);
      return print(await api("revision", { body: { virtualPath } }));
    }
    default:
      throw new ToolError("invalid", `Unknown command: ${cmd}. Run cabinet-documents --help.`);
  }
}

async function waitForJob(jobId: string): Promise<JobInfo> {
  const deadline = Date.now() + 15 * 60 * 1000;
  for (;;) {
    const job = (await api(`jobs/${encodeURIComponent(jobId)}`)) as JobInfo;
    if (job.status === "done" || job.status === "failed" || job.status === "cancelled") {
      return job;
    }
    if (Date.now() > deadline) {
      throw new ToolError("timeout", `Job ${jobId} did not finish within 15 minutes`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

main().catch(fail);
