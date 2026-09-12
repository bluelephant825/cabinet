import path from "node:path";
import fs from "node:fs/promises";
import { opaqueId, readWikiCabinet } from "./config";
import { contains, relativePath, ownedPath, statOrNull } from "./filesystem";
import { SourceStore } from "./source-store";
import { RawPublicationStore } from "./raw-publication";
import { readEvidenceDocument } from "./provenance";
import { originalDocument, readerHtml, safeHtml, notebookHtml } from "./reader-html";
import type { RawReaderResult } from "./reader-types";
import { resolveLegacyRawPath } from "./raw-layout";
const raster: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif" };
export async function readRawSource(root: string, selectedPath: string, selectedVersionId?: string | null): Promise<RawReaderResult> {
  if (selectedVersionId !== undefined && selectedVersionId !== null) opaqueId(selectedVersionId);
  const cabinet = await readWikiCabinet(root);
  if (!cabinet) return { kind: "ordinary" };
  selectedPath = await resolveLegacyRawPath(root, selectedPath);
  if (!contains(cabinet.config.paths.raw, selectedPath)) {
    if (!selectedPath) return { kind: "ordinary" };
    try { relativePath(selectedPath); } catch { return { kind: "ordinary" }; }
    const store = new SourceStore(root);
    let source = await store.findManaged({ kind: "cabinet", path: selectedPath });
    for (const candidate of [`${selectedPath}.md`, `${selectedPath}/index.md`]) {
      if (!source) source = await store.findManaged({ kind: "cabinet", path: candidate });
    }
    return { kind: "ordinary", ...(source ? { capturePath: source.currentVersionId ? source.rawPath : undefined, pending: !source.currentVersionId } : {}) };
  }
  relativePath(selectedPath);
  const entries = await new SourceStore(root).list();
  const entry = entries.find(({ source }) => contains(source.rawPath, selectedPath));
  if (!entry) return { kind: "directory", sources: entries.filter(({ source }) => contains(selectedPath, source.rawPath))
    .map(({ source }) => ({ id: source.id, title: source.title, path: source.rawPath, status: source.status })) };
  const relative = path.posix.relative(entry.source.rawPath, selectedPath);
  if (relative === "manifest.yaml") return { kind: "file", title: "manifest.yaml", text: await fs.readFile(await ownedPath(root, selectedPath), "utf8") };
  const linkedVersion = /^v([1-9][0-9]*)(?:\/|$)/.exec(path.posix.relative(entry.source.rawPath, selectedPath));
  const version = selectedVersionId ? entry.versions.find((item) => item.id === selectedVersionId)
    : linkedVersion ? entry.versions.find((item) => item.version === Number(linkedVersion[1]))
      : entry.versions.find((item) => item.id === entry.source.currentVersionId);
  if (!version) throw new Error(selectedVersionId || linkedVersion ? "Selected version does not belong to this Source." : "This Source has no captured version yet.");
  const store = new RawPublicationStore(root);
  const read = (file: string, limit = 20 * 1024 * 1024) => store.readCapturedFile(entry.source.id, version.id, file, limit);
  let selectedFile = linkedVersion ? relative.split("/").slice(1).join("/") : "";
  if (selectedFile && !["source", "source.md"].includes(selectedFile)) {
    let target = await ownedPath(root, `${entry.source.rawPath}/v${version.version}/${selectedFile}`);
    let stat = await statOrNull(target);
    if (!stat && !path.posix.extname(selectedFile)) {
      selectedFile += ".md";
      target = await ownedPath(root, `${entry.source.rawPath}/v${version.version}/${selectedFile}`);
      stat = await statOrNull(target);
    }
    if (stat?.isDirectory()) return { kind: "directory", sources: (await fs.readdir(target, { withFileTypes: true })).filter((item) => !item.isSymbolicLink()).map((item) => ({ id: item.name, title: item.name, path: `${entry.source.rawPath}/v${version.version}/${selectedFile}/${item.name}`, status: item.isDirectory() ? "folder" : "file" })) };
    const captured = await read(selectedFile);
    const extension = path.posix.extname(selectedFile).slice(1).toLowerCase();
    const download = `/api/llm-wiki/reader?source=${entry.source.id}&version=${version.id}&file=${encodeURIComponent(selectedFile)}`;
    if (raster[extension]) return { kind: "file", title: path.posix.basename(selectedFile), image: `data:${raster[extension]};base64,${captured.bytes.toString("base64")}`, download };
    if (["json", "yaml", "yml", "md", "markdown", "txt", "html", "htm", "csv", "tex", "typ", "ipynb"].includes(extension)) return { kind: "file", title: path.posix.basename(selectedFile), text: captured.bytes.toString("utf8"), download };
    return { kind: "file", title: path.posix.basename(selectedFile), download };
  }
  const { bytes } = await read("source.md");
  const markdown = bytes.toString("utf8");
  const body = readEvidenceDocument(markdown, { source: entry.source, version }).body;
  let imageBytes = 0;
  const image = (base: string) => async (url: string): Promise<string | null> => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(url)) return null;
    try {
      const name = path.posix.normalize(path.posix.join(base, decodeURIComponent(url.split(/[?#]/)[0])));
      relativePath(name);
      if (!name.startsWith(base === "assets" ? "assets/" : "capture/")) return null;
      const mime = raster[path.posix.extname(name).slice(1).toLowerCase()];
      if (!mime || imageBytes >= 8 * 1024 * 1024) return null;
      const file = await read(name, Math.min(2 * 1024 * 1024, 8 * 1024 * 1024 - imageBytes));
      imageBytes += file.bytes.length;
      return `data:${mime};base64,${file.bytes.toString("base64")}`;
    } catch { return null; }
  };
  // Normalized image paths already start with assets/, relative to source.md.
  const reader = await readerHtml(body, async (url) => url.startsWith("assets/") ? image("assets")(url.slice(7)) : null);
  let original: Extract<RawReaderResult, { kind: "source" }>["original"] = { kind: "download" };
  if (version.originalFormat === "pdf") original = { kind: "pdf" };
  else if (["html", "htm", "md", "markdown", "tex", "latex", "typ", "typst", "ipynb"].includes(version.originalFormat)) {
    try {
      const text = (await read(`original.${version.originalFormat}`, 2 * 1024 * 1024)).bytes.toString("utf8");
      if (["html", "htm"].includes(version.originalFormat)) {
        const capture = JSON.parse((await read("capture.json", 64 * 1024)).bytes.toString("utf8"));
        relativePath(capture.original);
        if (!capture.original.startsWith("capture/")) throw new Error("Invalid capture layout");
        original = { kind: "html", content: originalDocument(await safeHtml(text, image(path.posix.dirname(capture.original)), true)) };
      } else if (version.originalFormat === "ipynb") original = { kind: "html", content: await notebookHtml(text) };
      else original = { kind: "text", content: text };
    } catch { original = { kind: "download" }; }
  }
  return { kind: "source", cabinetId: entry.source.cabinetId, sourceId: entry.source.id, title: entry.source.title,
    sourcePath: entry.source.rawPath, currentVersionId: entry.source.currentVersionId!,
    versions: [...entry.versions].sort((a, b) => b.version - a.version).map((item) => ({ id: item.id, version: item.version,
      createdAt: item.createdAt, status: item.id === entry.source.currentVersionId ? "current" as const : "superseded" as const })),
    status: entry.source.status, versionId: version.id, version: version.version, format: version.originalFormat,
    filename: version.document?.originalFilename ?? `original.${version.originalFormat}`, markdown, readerHtml: reader, original };
}
