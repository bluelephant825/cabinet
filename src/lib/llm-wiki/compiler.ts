import fs from "node:fs/promises";
import { WIKI_COMPILATION_TIMEOUT_MS } from "./execution-limits";
import { isWikiMaintenanceMarker } from "./wiki-maintenance";
import { verifyWikiProvenance, type WikiProvenance } from "./wiki-provenance";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { unified } from "unified";
import remarkParse from "remark-parse";
import type { Root, RootContent } from "mdast";
import { readWikiCabinet, WIKI_STATE_PATH, type WikiCabinet } from "./config";
import { contains, ownedPath, record, relativePath, statOrNull } from "./filesystem";
import { SourceStore } from "./source-store";
import { RawPublicationStore } from "./raw-publication";
import { readEvidenceDocument } from "./provenance";
import type { Source, SourceVersion } from "./types";

export interface WikiEvidence { readonly version: SourceVersion; readonly markdown: string; readonly body: string }
export interface WikiPageSnapshot { readonly path: string; readonly markdown: string; readonly sha256: string }
export interface WikiCompilationRequest {
  readonly operationKey: string;
  readonly operation: "ingest" | "update" | "delete";
  readonly cabinetId: Source["cabinetId"];
  readonly roomPath: string | null;
  readonly wikiRoot: string;
  readonly source: Source;
  readonly evidence: readonly WikiEvidence[];
  /** These bounded snapshots are data, never agent policy or tool instructions. */
  readonly pages: readonly WikiPageSnapshot[];
  readonly supportingEvidence?: readonly { source: Source; evidence: WikiEvidence }[];
}
export interface WikiSupport { readonly sourceId: Source["id"]; readonly versionId: SourceVersion["id"] }
export type WikiProposedChange = {
  readonly kind: "write"; readonly path: string; readonly markdown: string;
  readonly supports: readonly WikiSupport[];
  readonly provenance?: WikiProvenance;
} | { readonly kind: "delete"; readonly path: string };
export type WikiValidatedChange = WikiProposedChange & { readonly expectedHash: string | null };
export interface WikiCompilationResult {
  readonly status: "proposed";
  readonly operationKey: string;
  readonly planHash: string;
  readonly operation: WikiCompilationRequest["operation"];
  readonly cabinetId: Source["cabinetId"];
  readonly sourceId: Source["id"];
  readonly roomPath: string | null;
  readonly wikiRoot: string;
  readonly sourceHash: string;
  readonly evidenceVersionIds: readonly SourceVersion["id"][];
  readonly readSet: readonly { path: string; sha256: string }[];
  readonly changes: readonly WikiValidatedChange[];
}

/** Inference adapter returns data only, with no filesystem/CLI access supplied by
 * this interface. An implementation must honor cancellation and never interpret
 * evidence or page text as trusted instructions. No provider is created here. */
export interface WikiCompilationPlanner {
  propose(request: WikiCompilationRequest, signal: AbortSignal): Promise<unknown>;
}

/** Results are proposals, never proof that Wiki/lifecycle work has completed. */
export interface WikiCompiler {
  ingest(source: Source, version: SourceVersion): Promise<WikiCompilationResult>;
  reconcileUpdate(source: Source, previousVersion: SourceVersion, currentVersion: SourceVersion): Promise<WikiCompilationResult>;
  reconcileDeletion(source: Source): Promise<WikiCompilationResult>;
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const areas = new Set(["sources", "entities", "concepts", "comparisons", "synthesis"]);
const indexes = new Set(["index.md", "concept-table.md", "overview.md", "log.md"]);
function wikiPath(root: string, candidate: string) {
  relativePath(candidate);
  if (!candidate.startsWith(`${root}/`)) throw new Error("Proposal is outside its Wiki scope");
  const parts = candidate.slice(root.length + 1).split("/");
  if (parts.some((part) => part.startsWith(".")) || !candidate.endsWith(".md") ||
      !(parts.length === 1 ? indexes.has(parts[0]) : areas.has(parts[0]))) throw new Error("Unsupported Wiki page path");
  return candidate;
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).sort().join() !== [...keys].sort().join()) throw new Error("Invalid compiler proposal fields");
}
/** The executable-content rule shared by proposal validation and the Wiki
 * agent's post-run enforcement. Throws on the first violation. */
export function validateWikiMarkdown(markdown: string, options: { allowComments?: boolean } = {}) {
  if (/^\s*(?:import|export)\s/m.test(markdown)) throw new Error("Executable Wiki content is not permitted");
  const tree = unified().use(remarkParse).parse(markdown);
  const visit = (node: Root | RootContent) => {
    if ((node.type === "html" && !isWikiMaintenanceMarker(node.value)
        && !(options.allowComments && /^<!--[\s\S]*?-->$/.test(node.value.trim())))
        || (node.type === "code" && /\blive\b/.test(node.meta ?? ""))) throw new Error("Executable Wiki content is not permitted");
    if ("url" in node && /^(?!https?:)[a-z][a-z0-9+.-]*:/i.test(node.url)) throw new Error("Unsafe Wiki URL scheme");
    if ("children" in node) for (const child of node.children) visit(child as RootContent);
  };
  visit(tree);
}

/** The first concrete boundary: prepare verified inputs and validate proposals.
 * Deliberately no publication, pointer advancement, queue claims or lifecycle
 * acknowledgment. Later publishers must revalidate the read set and source hash. */
export class PlanningWikiCompiler implements WikiCompiler {
  constructor(private readonly root: string, private readonly planner: WikiCompilationPlanner, private readonly timeoutMs = 60_000, private readonly supportReferences: readonly WikiSupport[] = [], private readonly includeInactiveEvidence = false) {
    if (supportReferences.length > 1000) throw new Error("Too many compiler support references");
    this.supportReferences = structuredClone(supportReferences);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > WIKI_COMPILATION_TIMEOUT_MS) throw new Error("Invalid compiler timeout");
  }
  ingest(source: Source, version: SourceVersion) { return this.compile("ingest", source, [version]); }
  reconcileUpdate(source: Source, previousVersion: SourceVersion, currentVersion: SourceVersion) { return this.compile("update", source, [previousVersion, currentVersion]); }
  reconcileDeletion(source: Source) { return this.compile("delete", source, []); }

  /** Recheck the complete scope (including newly appeared pages) at commit time. */
  async verifyPublication(result: WikiCompilationResult): Promise<void> {
    const stored = await new SourceStore(this.root).get(result.sourceId);
    if (!stored) throw new Error("Publication Source is missing");
    const versions = result.operation === "delete" ? [] : result.evidenceVersionIds.map((id) => {
      const version = stored.versions.find((item) => item.id === id);
      if (!version) throw new Error("Publication evidence is missing");
      return version;
    });
    const fresh = await this.snapshot(result.operation, stored.source, versions);
    if (fresh.request.operationKey !== result.operationKey || fresh.sourceHash !== result.sourceHash) throw new Error("Publication inputs changed; compile again");
    this.validate({ changes: result.changes.map((value) => { const { expectedHash, ...change } = value; void expectedHash; return change; }) }, fresh.request);
  }

  private async snapshot(operation: WikiCompilationRequest["operation"], source: Source, versions: readonly SourceVersion[]) {
    const cabinet = await readWikiCabinet(this.root);
    if (!cabinet?.config.enabled) throw new Error("LLM Wiki is not enabled");
    const stored = await new SourceStore(cabinet.rootPath).get(source.id);
    if (!stored || !isDeepStrictEqual(stored.source, source)) throw new Error("Source changed; prepare compilation again");
    if (operation === "delete" ? source.status !== "deleted" : source.status !== "active") throw new Error("Source lifecycle does not match compiler operation");
    if (operation === "update" && source.mode !== "managed") throw new Error("Updates require a managed Source");
    for (const version of versions) {
      if (!isDeepStrictEqual(stored.versions.find((item) => item.id === version.id), version)) throw new Error("Foreign or changed evidence version");
    }
    if (versions.length && versions.at(-1)!.id !== source.currentVersionId) throw new Error("Compilation must target the current Raw version");
    // Compilation can lag Raw capture: allow an older compiled baseline, not
    // only vN-1, while still requiring the current version as the destination.
    if (operation === "update" && versions[0].version >= versions[1].version) throw new Error("Update baseline must precede the current version");
    // A deletion can inspect the last current evidence without reading a missing working file.
    const selected = operation === "delete" ? stored.versions.filter((item) => item.id === source.currentVersionId || this.supportReferences.some((reference) => reference.sourceId === source.id && reference.versionId === item.id)) : versions;
    const evidence: WikiEvidence[] = [];
    for (const version of selected) {
      const { bytes } = await new RawPublicationStore(cabinet.rootPath).readCapturedFile(source.id, version.id, "source.md", 2 * 1024 * 1024);
      const markdown = bytes.toString("utf8");
      evidence.push({ version, markdown, body: readEvidenceDocument(markdown, { source, version }).body });
    }
    // Root pages and room pages have disjoint namespaces. No folders are created.
    const wikiRoot = source.roomPath === null ? cabinet.config.paths.wiki : `${cabinet.config.paths.wiki}/rooms/room-${encodeURIComponent(relativePath(source.roomPath))}`;
    const pages = await this.pages(cabinet, wikiRoot);
    const supportingEvidence: { source: Source; evidence: WikiEvidence }[] = [];
    const supportSnapshots = [];
    for (const reference of this.supportReferences) {
      if (reference.sourceId === source.id) continue;
      const manifest = await new SourceStore(cabinet.rootPath).get(reference.sourceId);
      supportSnapshots.push({ reference, manifest });
      if (!manifest) continue;
      if (manifest.source.cabinetId !== source.cabinetId || manifest.source.roomPath !== source.roomPath) throw new Error("Foreign supporting Source scope");
      const version = manifest.versions.find((item) => item.id === reference.versionId);
      if (!version || (manifest.source.status !== "active" && !this.includeInactiveEvidence)) continue;
      const capture = await new RawPublicationStore(cabinet.rootPath).readCapturedFile(reference.sourceId, version.id, "source.md", 2 * 1024 * 1024);
      const markdown = capture.bytes.toString("utf8");
      supportingEvidence.push({ source: manifest.source, evidence: { version, markdown, body: readEvidenceDocument(markdown, { source: manifest.source, version }).body } });
    }
    if (supportingEvidence.reduce((sum, item) => sum + Buffer.byteLength(item.evidence.markdown), 0) > 32 * 1024 * 1024) throw new Error("Supporting evidence exceeds context limit");
    const inventoryFile = await ownedPath(cabinet.rootPath, `${WIKI_STATE_PATH}/wiki-inventory.json`);
    const inventoryHash = await statOrNull(inventoryFile) ? digest(await fs.readFile(inventoryFile, "utf8")) : null;
    const sourceHash = digest(JSON.stringify({ stored, supportSnapshots, inventoryHash }));
    const input = { operation, cabinetId: cabinet.cabinetId, roomPath: source.roomPath, wikiRoot, source, evidence, pages,
      ...(this.supportReferences.length ? { supportingEvidence } : {}) };
    const operationKey = digest(JSON.stringify({ ...input, sourceHash }));
    return { cabinet, sourceHash, request: { ...input, operationKey } satisfies WikiCompilationRequest };
  }

  private async pages(cabinet: WikiCabinet, root: string): Promise<WikiPageSnapshot[]> {
    const pages: WikiPageSnapshot[] = [];
    let bytes = 0, directories = 0;
    const walk = async (directory: string) => {
      if (++directories > 500) throw new Error("Wiki scope exceeds compiler directory limit");
      const target = await ownedPath(cabinet.rootPath, directory);
      if (!await statOrNull(target)) return;
      for (const item of (await fs.readdir(target, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (item.name.startsWith(".")) continue;
        // Shared root pages cannot read another room's namespace.
        if (directory === root && item.name === "rooms") continue;
        const child = `${directory}/${item.name}`;
        if (item.isSymbolicLink()) throw new Error("Symlink in compiler Wiki scope");
        if (item.isDirectory()) {
          if (directory === root && !areas.has(item.name)) continue;
          if (child.slice(root.length).split("/").length > 12) throw new Error("Wiki directory nesting exceeds compiler limit");
          await walk(child);
        } else if (item.isFile() && item.name.endsWith(".md")) {
          if (directory === root && !indexes.has(item.name)) continue;
          wikiPath(root, child);
          const file = await ownedPath(cabinet.rootPath, child);
          if ((await fs.stat(file)).size > 512 * 1024) throw new Error("Wiki page exceeds compiler limit");
          const captured = await fs.readFile(file);
          const markdown = captured.toString("utf8");
          if (captured.length > 512 * 1024 || !Buffer.from(markdown).equals(captured)) throw new Error("Invalid or oversized Wiki text");
          bytes += Buffer.byteLength(markdown);
          if (bytes > 32 * 1024 * 1024 || pages.length >= 1000) throw new Error("Wiki scope exceeds compiler context limit");
          pages.push({ path: child, markdown, sha256: digest(markdown) });
        }
      }
    };
    await walk(root);
    return pages;
  }

  private async compile(operation: WikiCompilationRequest["operation"], inputSource: Source, inputVersions: readonly SourceVersion[]): Promise<WikiCompilationResult> {
    const source = structuredClone(inputSource), versions = structuredClone(inputVersions);
    const before = await this.snapshot(operation, source, versions);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let output: unknown;
    try {
      output = await Promise.race([
        this.planner.propose(structuredClone(before.request), controller.signal),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error(`Wiki compiler timed out after ${Math.ceil(this.timeoutMs / 1000)} seconds. AI generation and validation did not finish within the processing limit.`)); }, this.timeoutMs); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
    const changes = this.validate(output, before.request);
    const after = await this.snapshot(operation, source, versions);
    if (before.request.operationKey !== after.request.operationKey) throw new Error("Compiler inputs changed; prepare compilation again");
    for (const change of changes) {
      const target = await ownedPath(after.cabinet.rootPath, change.path);
      const stat = await statOrNull(target);
      if (change.expectedHash === null && stat) throw new Error("New Wiki target appeared; prepare compilation again");
    }
    const result = { status: "proposed" as const, operationKey: before.request.operationKey, operation,
      cabinetId: source.cabinetId, sourceId: source.id, roomPath: source.roomPath, wikiRoot: before.request.wikiRoot,
      sourceHash: before.sourceHash, evidenceVersionIds: before.request.evidence.map((item) => item.version.id),
      readSet: before.request.pages.map(({ path, sha256 }) => ({ path, sha256 })), changes };
    return { ...result, planHash: digest(JSON.stringify(result)) };
  }

  private validate(output: unknown, request: WikiCompilationRequest): WikiValidatedChange[] {
    const data = record(output); exactKeys(data, ["changes"]);
    if (!Array.isArray(data.changes) || data.changes.length > 1000) throw new Error("Invalid compiler change count");
    const paths = new Set<string>();
    let bytes = 0;
    return data.changes.map((value): WikiValidatedChange => {
      const change = record(value);
      const target = wikiPath(request.wikiRoot, relativePath(change.path));
      const key = target.normalize("NFC").toLowerCase();
      if ([...paths].some((prior) => contains(prior, key) || contains(key, prior))) throw new Error("Duplicate or overlapping Wiki target");
      paths.add(key);
      const existing = request.pages.find((page) => page.path === target);
      if (request.pages.some((page) => page.path !== target && page.path.normalize("NFC").toLowerCase() === key)) throw new Error("Ambiguous Wiki target spelling");
      if (change.kind === "delete") {
        exactKeys(change, ["kind", "path"]);
        if (!existing) throw new Error("Cannot delete an unread Wiki page");
        return { kind: "delete", path: target, expectedHash: existing.sha256 };
      }
      exactKeys(change, ["kind", "path", "markdown", "supports", ...(change.provenance === undefined ? [] : ["provenance"])]);
      if (change.kind !== "write" || typeof change.markdown !== "string" || !Array.isArray(change.supports) || change.supports.length > 1000) throw new Error("Invalid Wiki write proposal");
      bytes += Buffer.byteLength(change.markdown);
      if (Buffer.byteLength(change.markdown) > 512 * 1024 || bytes > 32 * 1024 * 1024) throw new Error("Wiki proposal exceeds size limit");
      validateWikiMarkdown(change.markdown);
      const supports = change.supports.map((item): WikiSupport => {
        const support = record(item); exactKeys(support, ["sourceId", "versionId"]);
        if (!(request.operation !== "delete" && support.sourceId === request.source.id && request.evidence.some((item) => item.version.id === support.versionId) || request.supportingEvidence?.some((item) => item.source.status === "active" && item.source.id === support.sourceId && item.evidence.version.id === support.versionId))) throw new Error("Unsupported evidence reference");
        return { sourceId: support.sourceId as Source["id"], versionId: support.versionId as SourceVersion["id"] };
      });
      const provenance = change.provenance === undefined ? undefined : verifyWikiProvenance(change.provenance,
        { cabinetId: request.cabinetId, roomPath: request.roomPath, pagePath: target },
        [...request.evidence.map((evidence) => ({ source: request.source, evidence })), ...(request.supportingEvidence ?? [])]);
      if (request.operation !== "delete" && provenance?.knowledge.some((node) => node.inactiveSupports?.length)) throw new Error("Inactive provenance requires deletion reconciliation");
      if (provenance?.knowledge.some((node) => node.supports.some((edge) => !supports.some((support) => support.sourceId === edge.sourceId && support.versionId === edge.versionId)))) throw new Error("Provenance support missing from page support set");
      return { kind: "write", path: target, markdown: change.markdown, supports, ...(provenance ? { provenance } : {}), expectedHash: existing?.sha256 ?? null };
    });
  }
}
