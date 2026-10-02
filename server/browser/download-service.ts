import { createHash, randomBytes } from "node:crypto";
import { promises as dns } from "node:dns";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import path from "node:path";
import { CABINET_INTERNAL_DIR } from "../../src/lib/storage/path-utils";
import { appendOrder, setEntryOrder } from "../../src/lib/storage/order-store";
import type { DocumentService } from "../documents/service";
import { maxDocumentBytes } from "../documents/persistence";
import type { BrowserRunContext, BrowserToolResult } from "./automation-service";

const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".pdf", ".docx", ".xlsx", ".pptx", ".txt", ".csv", ".json"]);
const DOCUMENT_EXTENSIONS = new Set([".pdf", ".docx", ".xlsx", ".pptx"]);

type DownloadResult = {
  virtualPath: string;
  sourceUrl: string;
  finalUrl: string;
  bytes: number;
  mimeType: string;
  sha256: string;
  createdPaths: string[];
  conversionJobId?: string;
  conversionError?: string;
};

type FetchResult = {
  tempPath: string;
  sourceUrl: string;
  finalUrl: string;
  bytes: number;
  mimeType: string;
  sha256: string;
  suggestedName: string;
};

type DownloadOptions = {
  documentService: DocumentService;
  lookup?: typeof dns.lookup;
  maxBytes?: number;
  request?: (url: URL, deadline: number) => Promise<http.IncomingMessage>;
};

function publicIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 192 && b === 0 && (c === 2 || c === 0)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

const blockedIpv6 = new BlockList();
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) blockedIpv6.addSubnet(network, prefix, "ipv6");

function publicIp(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return publicIpv4(address);
  if (version !== 6) return false;
  const normalized = address.toLowerCase().split("%", 1)[0];
  return !blockedIpv6.check(normalized, "ipv6");
}

function cleanFilename(value: string): string {
  const decoded = value.normalize("NFKC").replace(/[\\/\0]/g, "-").replace(/[^\p{L}\p{N}._ -]/gu, "-").trim();
  const compact = decoded.replace(/\s+/g, " ").replace(/^\.+/, "");
  return compact.slice(0, 180) || "download";
}

function contentDispositionName(value: string | undefined): string | null {
  if (!value) return null;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded); } catch {}
  }
  return /filename="?([^";]+)"?/i.exec(value)?.[1]?.trim() ?? null;
}

function scopedDirectory(context: BrowserRunContext, requested: unknown): string {
  const value = typeof requested === "string" ? requested.trim().replace(/\\/g, "/") : "";
  const segments = value.split("/").filter(Boolean);
  if (!segments.length || value.startsWith("/") || segments.some((segment) => segment === ".." || segment === "." || segment.startsWith("."))) {
    throw new Error("destinationDir must be a visible folder inside the active room");
  }
  const room = (context.cabinetPath ?? "").split("/").filter(Boolean);
  return [...room, ...segments].join("/");
}

function provenanceUrl(raw: string): string {
  const url = new URL(raw);
  return `${url.origin}${url.pathname}`;
}

export class BrowserDownloadService {
  private readonly documentService: DocumentService;
  private readonly lookup: typeof dns.lookup;
  private readonly maxBytes: number;
  private readonly requestOverride?: (url: URL, deadline: number) => Promise<http.IncomingMessage>;
  private readonly stagingDir = path.join(CABINET_INTERNAL_DIR, "browser-downloads");

  constructor(options: DownloadOptions) {
    this.documentService = options.documentService;
    this.lookup = options.lookup ?? dns.lookup;
    this.maxBytes = Math.min(MAX_DOWNLOAD_BYTES, maxDocumentBytes(), options.maxBytes ?? MAX_DOWNLOAD_BYTES);
    this.requestOverride = options.request;
  }

  async call(
    context: BrowserRunContext,
    name: string,
    args: Record<string, unknown>,
    readTab: (tabId: string) => Promise<BrowserToolResult>,
  ): Promise<BrowserToolResult> {
    if (name === "browser_save_page") return this.savePage(context, args, readTab);
    if (name === "browser_download" || name === "browser_import_pdf") {
      const result = await this.download(context, args, name === "browser_import_pdf");
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as unknown as Record<string, unknown> };
    }
    throw new Error(`Unknown Cabinet browser import tool: ${name}`);
  }

  private async download(context: BrowserRunContext, args: Record<string, unknown>, pdfOnly: boolean): Promise<DownloadResult> {
    const sourceUrl = typeof args.url === "string" ? args.url : "";
    const destinationDir = scopedDirectory(context, args.destinationDir);
    const fetched = await this.fetchToStage(sourceUrl);
    try {
      let filename = cleanFilename(typeof args.filename === "string" ? args.filename : fetched.suggestedName);
      let extension = path.extname(filename).toLowerCase();
      if (!extension && fetched.mimeType === "application/pdf") {
        filename += ".pdf";
        extension = ".pdf";
      }
      if (!ALLOWED_EXTENSIONS.has(extension) || (pdfOnly && extension !== ".pdf")) {
        throw new Error(pdfOnly ? "The URL did not return a PDF" : `Unsupported download type: ${extension || fetched.mimeType}`);
      }
      if (fetched.mimeType.includes("html")) {
        throw new Error("The download returned an HTML page instead of a supported file");
      }
      const destinationVirtualPath = `${destinationDir}/${filename}`;
      const actor = { kind: "agent" as const, id: context.agentSlug, runId: context.runId };
      const imported = DOCUMENT_EXTENSIONS.has(extension)
        ? await this.documentService.importStaged({ destinationVirtualPath, tempPath: fetched.tempPath, actor })
        : await this.documentService.importText({ destinationVirtualPath, bytes: await fsp.readFile(fetched.tempPath), actor });
      await this.assignOrder(imported.virtualPath);
      const provenance = {
        sourceUrl: provenanceUrl(fetched.sourceUrl),
        finalUrl: provenanceUrl(fetched.finalUrl),
        importedAt: new Date().toISOString(),
        sha256: fetched.sha256,
        bytes: fetched.bytes,
        mimeType: fetched.mimeType,
      };
      const metadataName = `.cabinet-source-${path.basename(imported.virtualPath)}.json`;
      const metadataPath = `${path.posix.dirname(imported.virtualPath)}/${metadataName}`;
      const metadata = await this.documentService.importText({
        destinationVirtualPath: metadataPath,
        bytes: Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`),
        actor,
      });
      const result: DownloadResult = {
        virtualPath: imported.virtualPath,
        sourceUrl: provenance.sourceUrl,
        finalUrl: provenance.finalUrl,
        bytes: fetched.bytes,
        mimeType: fetched.mimeType,
        sha256: fetched.sha256,
        createdPaths: [imported.virtualPath, metadata.virtualPath],
      };
      if (pdfOnly && args.convertToMarkdown === true) {
        try {
          const opened = await this.documentService.open({ virtualPath: imported.virtualPath, actor });
          const converted = await this.documentService.convert({
            virtualPath: imported.virtualPath,
            baseRevision: opened.revision,
            target: "md",
            actor,
          });
          result.conversionJobId = converted.jobId;
        } catch (error) {
          result.conversionError = error instanceof Error ? error.message : "PDF conversion could not be started";
        }
      }
      return result;
    } finally {
      await fsp.rm(fetched.tempPath, { force: true }).catch(() => {});
    }
  }

  private async savePage(
    context: BrowserRunContext,
    args: Record<string, unknown>,
    readTab: (tabId: string) => Promise<BrowserToolResult>,
  ): Promise<BrowserToolResult> {
    const tabId = typeof args.tabId === "string" ? args.tabId : "";
    if (!tabId) throw new Error("tabId is required");
    const read = await readTab(tabId);
    if (read.isError) return read;
    const text = read.content
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text as string)
      .join("\n");
    const fenced = /<untrusted_page_markdown[^>]*>\s*<interactive_page_markdown>([\s\S]*?)<\/interactive_page_markdown>\s*<\/untrusted_page_markdown>/i.exec(text)?.[1]
      ?? text;
    const url = /(?:^|\n)URL:\s*(https?:\/\/\S+)/i.exec(text)?.[1] ?? "";
    const requestedTitle = typeof args.title === "string" ? args.title.trim() : "";
    const pageTitle = /(?:^|\n)Tab:\s*"([^"]+)"/i.exec(text)?.[1] ?? "Web page";
    const title = requestedTitle || pageTitle;
    const filename = `${cleanFilename(title).replace(/\.md$/i, "") || "web-page"}.md`;
    const destinationDir = scopedDirectory(context, args.destinationDir);
    const escaped = fenced
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>\n]+>/g, (value) => `\`${value.replace(/`/g, "'")}\``)
      .replace(/\{aloha-id="[^"]+"[^}]*\}/g, "")
      .trim();
    const frontmatter = [
      "---",
      `title: ${JSON.stringify(title)}`,
      ...(url ? [`source: ${JSON.stringify(provenanceUrl(url))}`] : []),
      `captured: ${JSON.stringify(new Date().toISOString())}`,
      "---",
      "",
    ].join("\n");
    const actor = { kind: "agent" as const, id: context.agentSlug, runId: context.runId };
    const imported = await this.documentService.importText({
      destinationVirtualPath: `${destinationDir}/${filename}`,
      bytes: Buffer.from(`${frontmatter}${escaped}\n`),
      actor,
    });
    await this.assignOrder(imported.virtualPath);
    const result = { virtualPath: imported.virtualPath, createdPaths: [imported.virtualPath], truncated: /\.\.\./.test(escaped) };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  }

  private async assignOrder(virtualPath: string): Promise<void> {
    try {
      const directory = path.posix.dirname(virtualPath);
      const filename = path.posix.basename(virtualPath);
      const target = directory === "." ? "" : directory;
      const order = await appendOrder(target);
      await setEntryOrder(target, filename, order);
    } catch {}
  }

  private async fetchToStage(source: string): Promise<FetchResult> {
    let current: URL;
    try { current = new URL(source); } catch { throw new Error("A valid public HTTP or HTTPS URL is required"); }
    if (!/^https?:$/.test(current.protocol) || current.username || current.password) {
      throw new Error("A public HTTP or HTTPS URL without embedded credentials is required");
    }
    await fsp.mkdir(this.stagingDir, { recursive: true, mode: 0o700 });
    const tempPath = path.join(this.stagingDir, `${randomBytes(16).toString("hex")}.part`);
    const deadline = Date.now() + 60_000;
    let response: http.IncomingMessage | null = null;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      response = await (this.requestOverride ? this.requestOverride(current, deadline) : this.request(current, deadline));
      if (![301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) break;
      const location = response.headers.location;
      response.resume();
      if (!location || redirects === 5) throw new Error("Download redirect limit exceeded");
      current = new URL(location, current);
      if (!/^https?:$/.test(current.protocol) || current.username || current.password) throw new Error("Download redirected to an unsupported URL");
    }
    if (!response || (response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
      response?.resume();
      throw new Error(`Download failed (${response?.statusCode ?? "no response"})`);
    }
    const declared = Number(response.headers["content-length"] ?? 0);
    if (declared > this.maxBytes) {
      response.destroy();
      throw new Error("Download exceeds the size limit");
    }
    const output = fs.createWriteStream(tempPath, { mode: 0o600, flags: "wx" });
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      for await (const value of response) {
        const chunk = value as Buffer;
        bytes += chunk.length;
        if (bytes > this.maxBytes || Date.now() > deadline) throw new Error(bytes > this.maxBytes ? "Download exceeds the size limit" : "Download timed out");
        hash.update(chunk);
        await new Promise<void>((resolve, reject) => output.write(chunk, (error) => error ? reject(error) : resolve()));
      }
      await new Promise<void>((resolve, reject) => {
        output.once("error", reject);
        output.end(resolve);
      });
    } catch (error) {
      output.destroy();
      response.destroy();
      await fsp.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
    const disposition = Array.isArray(response.headers["content-disposition"])
      ? response.headers["content-disposition"][0]
      : response.headers["content-disposition"];
    return {
      tempPath,
      sourceUrl: source,
      finalUrl: current.toString(),
      bytes,
      mimeType: String(response.headers["content-type"] ?? "application/octet-stream").split(";", 1)[0].toLowerCase(),
      sha256: hash.digest("hex"),
      suggestedName: cleanFilename(contentDispositionName(disposition) ?? path.posix.basename(current.pathname) ?? "download"),
    };
  }

  private async request(url: URL, deadline: number): Promise<http.IncomingMessage> {
    const addresses = await this.lookup(url.hostname, { all: true, verbatim: true });
    const candidates = addresses.filter((entry) => publicIp(entry.address));
    if (!candidates.length || candidates.length !== addresses.length) throw new Error("Download host resolves to a private or reserved address");
    const address = candidates[0];
    const timeout = Math.max(1, deadline - Date.now());
    const requestFn = url.protocol === "https:" ? https.request : http.request;
    return await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = requestFn({
        protocol: url.protocol,
        hostname: address.address,
        family: address.family,
        port: url.port || undefined,
        method: "GET",
        path: `${url.pathname}${url.search}`,
        servername: url.protocol === "https:" ? url.hostname : undefined,
        headers: { host: url.host, accept: "application/pdf,application/octet-stream,text/plain,text/csv,application/json,*/*;q=0.1", "user-agent": "Cabinet/1" },
        timeout,
      }, resolve);
      request.once("timeout", () => request.destroy(new Error("Download timed out")));
      request.once("error", reject);
      request.end();
    });
  }
}

export { publicIp, cleanFilename, scopedDirectory };
