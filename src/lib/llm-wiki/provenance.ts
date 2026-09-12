import path from "node:path";
import { createHash } from "node:crypto";
import yaml from "js-yaml";
import { opaqueId } from "./config";
import { record, relativePath } from "./filesystem";
import type { NormalizedSource } from "./normalizers";
import type { CabinetId, Source, SourceDocumentMetadata, SourceId, SourceType, SourceVersion, SourceVersionId } from "./types";

export interface EvidenceFrontMatter {
  readonly schema_version: 1;
  readonly cabinet_id: CabinetId;
  readonly source_id: SourceId;
  readonly source_version_id: SourceVersionId;
  readonly source_version: number;
  readonly title: string;
  readonly source_type: SourceType;
  readonly original_filename: string;
  readonly original_format: string;
  readonly language?: string;
  readonly imported_at: string;
  readonly sha256: string;
  readonly conversion: { readonly tool: string; readonly version: string };
}

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_MARKDOWN_BYTES = 20 * 1024 * 1024;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const formats: Record<string, SourceType> = { md: "markdown", markdown: "markdown", html: "html", htm: "html",
  pdf: "pdf", doc: "document", docx: "document", odt: "document", ppt: "presentation", pptx: "presentation",
  tex: "latex", latex: "latex", typ: "typst", typst: "typst", ipynb: "notebook" };
const fields = ["schema_version", "cabinet_id", "source_id", "source_version_id", "source_version", "title",
  "source_type", "original_filename", "original_format", "language", "imported_at", "sha256", "conversion"];

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error("Unknown provenance field");
}
function text(value: unknown, max = 1024): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid provenance text");
  return value;
}
function timestamp(value: unknown): string {
  const date = text(value);
  if (!Number.isFinite(Date.parse(date)) || new Date(date).toISOString() !== date) throw new Error("Invalid provenance timestamp");
  return date;
}
function language(value: unknown): string {
  const tag = text(value, 64);
  if (!/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/.test(tag)) throw new Error("Invalid language tag");
  return tag;
}
export function sourceType(format: string): SourceType {
  if (!Object.hasOwn(formats, format)) throw new Error("Unknown provenance format");
  return formats[format];
}

export function parseDocumentMetadata(value: unknown, format: string): SourceDocumentMetadata {
  const data = record(value);
  onlyKeys(data, ["title", "sourceType", "originalFilename", "language"]);
  text(data.title);
  const filename = relativePath(text(data.originalFilename, 255));
  if (filename.includes("/") || path.posix.extname(filename).slice(1).toLowerCase() !== format) throw new Error("Original filename/format mismatch");
  if (data.sourceType !== sourceType(format)) throw new Error("Source type/format mismatch");
  if (data.language !== undefined) language(data.language);
  return { title: data.title as string, sourceType: data.sourceType, originalFilename: filename,
    ...(data.language === undefined ? {} : { language: data.language as string }) } as SourceDocumentMetadata;
}

export function parseEvidenceFrontMatter(value: unknown): EvidenceFrontMatter {
  const data = record(value);
  onlyKeys(data, fields);
  if (data.schema_version !== 1) throw new Error("Unsupported evidence schema");
  opaqueId(data.cabinet_id); opaqueId(data.source_id); opaqueId(data.source_version_id);
  if (!Number.isSafeInteger(data.source_version) || (data.source_version as number) < 1) throw new Error("Invalid evidence version number");
  const format = text(data.original_format, 16);
  const document = parseDocumentMetadata({ title: data.title, sourceType: data.source_type,
    originalFilename: data.original_filename, ...(data.language === undefined ? {} : { language: data.language }) }, format);
  timestamp(data.imported_at);
  if (typeof data.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(data.sha256)) throw new Error("Invalid evidence SHA-256");
  const conversion = record(data.conversion);
  onlyKeys(conversion, ["tool", "version"]);
  text(conversion.tool, 128); text(conversion.version, 128);
  return { schema_version: 1, cabinet_id: data.cabinet_id as CabinetId, source_id: data.source_id as SourceId,
    source_version_id: data.source_version_id as SourceVersionId, source_version: data.source_version as number,
    title: document.title, source_type: document.sourceType, original_filename: document.originalFilename,
    original_format: format, ...(document.language ? { language: document.language } : {}),
    imported_at: data.imported_at as string, sha256: data.sha256,
    conversion: { tool: conversion.tool as string, version: conversion.version as string } };
}

/** Validate a header against registry identity and captured provenance, not the
 * mutable current pointer or mutable source title (historical versions stay valid).
 */
export function assertEvidenceMatches(header: EvidenceFrontMatter, source: Source, version: SourceVersion): void {
  const valid = parseEvidenceFrontMatter(header);
  relativePath(source.rawPath);
  const base = `${source.rawPath}/v${version.version}`;
  if (version.originalPath !== `${base}/original.${version.originalFormat}` || version.markdownPath !== `${base}/source.md` ||
      (version.assetsPath !== undefined && version.assetsPath !== `${base}/assets`)) throw new Error("Invalid evidence version paths");
  if (valid.cabinet_id !== source.cabinetId || valid.cabinet_id !== version.cabinetId ||
      valid.source_id !== source.id || valid.source_id !== version.sourceId || valid.source_version_id !== version.id ||
      valid.source_version !== version.version || valid.sha256 !== version.contentHash || valid.original_format !== version.originalFormat ||
      valid.imported_at !== version.createdAt) throw new Error("Evidence/manifest provenance mismatch");
  if (version.converter && (valid.conversion.tool !== version.converter.name || valid.conversion.version !== version.converter.version)) {
    throw new Error("Evidence converter mismatch");
  }
  if (version.document) {
    const document = parseDocumentMetadata(version.document, version.originalFormat);
    if (valid.title !== document.title || valid.source_type !== document.sourceType || valid.original_filename !== document.originalFilename ||
        valid.language !== document.language) throw new Error("Evidence document metadata mismatch");
  }
}

/** Pure preparation for later promotion. No ID allocation, manifest mutation,
 * filesystem publication or queue transitions happen here.
 */
export function prepareEvidenceDocument(normalized: NormalizedSource, source: Source, version: SourceVersion) {
  if (sha256(normalized.original.bytes) !== normalized.original.contentHash || version.contentHash !== normalized.original.contentHash ||
      version.originalFormat !== normalized.original.format) throw new Error("Normalized original/provenance mismatch");
  const candidateLanguage = normalized.metadata.language;
  const document = parseDocumentMetadata({ title: version.document?.title ?? source.title,
    sourceType: sourceType(normalized.original.format), originalFilename: normalized.original.filename,
    ...(candidateLanguage == null ? {} : { language: candidateLanguage }) }, normalized.original.format);
  const frontMatter = parseEvidenceFrontMatter({ schema_version: 1, cabinet_id: source.cabinetId, source_id: source.id,
    source_version_id: version.id, source_version: version.version, title: document.title, source_type: document.sourceType,
    original_filename: document.originalFilename, original_format: version.originalFormat,
    ...(document.language ? { language: document.language } : {}), imported_at: version.createdAt, sha256: version.contentHash,
    conversion: { tool: normalized.converter.name, version: normalized.converter.version } });
  assertEvidenceMatches(frontMatter, source, version);
  const enriched: SourceVersion = { ...version, converter: { ...normalized.converter }, document };
  const header = yaml.dump(frontMatter, { schema: yaml.JSON_SCHEMA, lineWidth: -1, noRefs: true });
  if (Buffer.byteLength(header) > MAX_HEADER_BYTES) throw new Error("Evidence header exceeds size limit");
  if (typeof normalized.body !== "string" || Buffer.byteLength(normalized.body) > MAX_MARKDOWN_BYTES) throw new Error("Invalid evidence body");
  return { frontMatter, version: enriched, markdown: `---\n${header}---\n${normalized.body}` };
}

export function readEvidenceDocument(markdown: string, expected?: { source: Source; version: SourceVersion }) {
  if (Buffer.byteLength(markdown) > MAX_MARKDOWN_BYTES + MAX_HEADER_BYTES + 8) throw new Error("Evidence document exceeds size limit");
  const end = markdown.indexOf("\n---\n", 4);
  if (!markdown.startsWith("---\n") || end < 0 || Buffer.byteLength(markdown.slice(4, end)) > MAX_HEADER_BYTES) throw new Error("Invalid evidence header");
  const frontMatter = parseEvidenceFrontMatter(yaml.load(markdown.slice(4, end), { schema: yaml.JSON_SCHEMA }));
  if (expected) assertEvidenceMatches(frontMatter, expected.source, expected.version);
  return { frontMatter, body: markdown.slice(end + 5) };
}
