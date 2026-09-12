import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ownedPath, record, relativePath } from "../../src/lib/llm-wiki/filesystem";
import { CONVERSION_FORMATS, SourceNormalizationService } from "../../src/lib/llm-wiki/normalizers";
import { copyAssets, MAX_MARKDOWN_BYTES, sha256, validateMetadata } from "../../src/lib/llm-wiki/normalizers/markdown";
import type { CapturedAsset, DocumentConverter, DocumentConversionResult, SourceFile } from "../../src/lib/llm-wiki/normalizers";
import { XbergError, XbergProcessWorker } from "./xberg-worker";

export const XBERG_VERSION = "1.1.5";

async function executablePath(configured?: string): Promise<string> {
  const setting = configured ?? process.env.CABINET_XBERG_PATH;
  if (setting && !path.isAbsolute(setting)) throw new XbergError("unavailable", "CABINET_XBERG_PATH must name an absolute executable path");
  const candidates = setting ? [setting] : (process.env.PATH ?? "").split(path.delimiter)
    .filter((item) => path.isAbsolute(item)).map((dir) => path.join(dir, process.platform === "win32" ? "xberg.exe" : "xberg"));
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, constants.X_OK);
      const target = await fs.realpath(candidate);
      if ((await fs.stat(target)).isFile()) return target;
    } catch { /* Try the next installed path. */ }
  }
  throw new XbergError("unavailable", `Xberg ${XBERG_VERSION} is unavailable; install the CLI and set CABINET_XBERG_PATH`);
}

/** Strict translation of the pinned CLI's JSON envelope. No output paths are read. */
export function decodeXbergOutput(output: string, version: string): DocumentConversionResult {
  let envelope: Record<string, unknown>;
  try { envelope = record(JSON.parse(output)); } catch { throw new XbergError("protocol", "Xberg returned invalid JSON"); }
  const result = record(envelope.result);
  if (typeof result.content !== "string" || Buffer.byteLength(result.content) > MAX_MARKDOWN_BYTES) throw new XbergError("protocol", "Invalid or oversized xberg Markdown");
  const metadata = record(result.metadata);
  validateMetadata(metadata);
  if (metadata.output_format !== "markdown") throw new XbergError("protocol", "Xberg did not return Markdown");
  // Temporary machine-local provenance must not enter portable source metadata.
  if (metadata.additional && typeof metadata.additional === "object") {
    const additional = { ...record(metadata.additional) };
    delete additional.source_uri; delete additional.final_uri;
    metadata.additional = additional;
  }
  const warnings: string[] = [];
  if (result.processing_warnings != null) {
    if (!Array.isArray(result.processing_warnings)) throw new XbergError("protocol", "Invalid xberg warnings");
    for (const value of result.processing_warnings) {
      const warning = record(value);
      if (typeof warning.message !== "string") throw new XbergError("protocol", "Invalid xberg warning");
      warnings.push(warning.message);
    }
  }
  const images = result.images ?? [];
  if (!Array.isArray(images) || images.length > 256) throw new XbergError("protocol", "Too many xberg images");
  const assets: CapturedAsset[] = [];
  for (const [index, value] of images.entries()) {
    const image = record(value);
    if (typeof image.format !== "string" || !/^[a-zA-Z0-9]{1,16}$/.test(image.format) ||
        !Array.isArray(image.data) || image.data.length > 50 * 1024 * 1024 ||
        image.data.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new XbergError("protocol", "Invalid xberg image bytes");
    const assetPath = typeof image.source_path === "string" && image.source_path
      ? relativePath(image.source_path) : `image_${index}.${image.format.toLowerCase()}`;
    const decoded = Uint8Array.from(image.data);
    const previous = assets.find((asset) => asset.path === assetPath);
    if (previous && sha256(previous.bytes) !== sha256(decoded)) throw new XbergError("protocol", "Conflicting xberg image path");
    if (!previous) assets.push({ path: assetPath, bytes: decoded });
  }
  if (!result.content.trim() && !assets.length) throw new XbergError("protocol", "Xberg extracted no content; scanned documents may require OCR");
  if (assets.length) warnings.push("Extracted images are retained; unresolved image references remain visible as normalization warnings.");
  return { markdown: result.content, metadata, assets: copyAssets(assets), warnings,
    converter: { name: "xberg", version }, parseFrontMatter: false };
}

export class XbergAdapter implements DocumentConverter {
  private readonly worker: XbergProcessWorker;
  private readonly active = new Set<Promise<DocumentConversionResult>>();
  private closed = false;
  constructor(private readonly options: { executable?: string; timeoutMs?: number; maxOutputBytes?: number } = {}) {
    this.worker = new XbergProcessWorker(options);
  }

  convert(input: SourceFile): Promise<DocumentConversionResult> {
    if (this.closed) return Promise.reject(new XbergError("aborted", "Xberg adapter is closed"));
    if (this.active.size >= 4) return Promise.reject(new XbergError("busy", "Xberg adapter is busy"));
    const task = this.convertCaptured(input);
    this.active.add(task);
    void task.finally(() => this.active.delete(task)).catch(() => {});
    return task;
  }

  private async convertCaptured(input: SourceFile): Promise<DocumentConversionResult> {
    relativePath(input.path);
    const format = path.posix.extname(input.path).slice(1).toLowerCase();
    if (!(CONVERSION_FORMATS as readonly string[]).includes(format)) throw new Error("Unsupported xberg source format");
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength > 500 * 1024 * 1024) throw new Error("Invalid or oversized original");
    const bytes = Uint8Array.from(input.bytes);
    if (sha256(bytes) !== input.contentHash) throw new Error("Captured original hash mismatch");
    const assets = copyAssets(input.assets ?? []);
    if (assets.some((asset) => asset.path.normalize("NFC").toLowerCase() === input.path.normalize("NFC").toLowerCase())) throw new Error("Asset collides with original");
    const executable = await executablePath(this.options.executable);
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-xberg-"));
    try {
      const probe = await this.worker.run(executable, ["--version"], temporary);
      const version = /^xberg (\d+\.\d+\.\d+)\s*$/.exec(probe.stdout)?.[1];
      if (version !== XBERG_VERSION) throw new XbergError("protocol", `Cabinet requires verified xberg ${XBERG_VERSION}; found ${version ?? "unknown version"}`);
      const captureRoot = path.join(temporary, "input");
      await fs.mkdir(captureRoot);
      for (const item of [{ path: input.path, bytes }, ...assets]) {
        const target = await ownedPath(captureRoot, item.path);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, item.bytes, { flag: "wx", mode: 0o400 });
      }
      const result = await this.worker.run(executable, ["extract", path.join(captureRoot, input.path),
        "--no-config-discovery", "--format", "json", "--content-format", "markdown", "--ocr", "false",
        "--no-cache", "true", "--extract-images", "true", "--max-threads", "2"], temporary);
      const converted = decodeXbergOutput(result.stdout, version);
      // Preserve the captured document's base for relative dependencies, including
      // references to siblings of its containing folder.
      const merged = new Map(converted.assets.map((asset) => {
        const rebased = { ...asset, path: path.posix.join(path.posix.dirname(input.path), asset.path) };
        return [rebased.path, rebased];
      }));
      for (const asset of assets) {
        const previous = merged.get(asset.path);
        if (previous && sha256(previous.bytes) !== sha256(asset.bytes)) throw new Error("Conflicting extracted asset path");
        merged.set(asset.path, asset);
      }
      return { ...converted, markdownPath: input.path, assets: copyAssets([...merged.values()]), warnings: [...converted.warnings,
        ...(format === "pdf" ? ["OCR is disabled; scanned text may be absent."] : []),
        ...(result.stderr.trim() ? ["Xberg emitted diagnostics; extraction may be incomplete."] : [])] };
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }

  async close(): Promise<void> {
    this.closed = true; await this.worker.close(); await Promise.allSettled([...this.active]);
  }
}

/** Future ingestion worker composition; construction does not consume jobs. */
export function createXbergNormalization(options?: ConstructorParameters<typeof XbergAdapter>[0]) {
  const adapter = new XbergAdapter(options);
  return { normalizer: new SourceNormalizationService(adapter), close: () => adapter.close() };
}
