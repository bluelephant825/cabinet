/**
 * DocumentService — application-level document API for the daemon.
 *
 * Every write follows: authorizeDocumentPath(write) → path mutex → commitBytes.
 * Engine work happens in pooled worker processes via the broker; this layer
 * only orchestrates policy, revisions, sessions, and jobs.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { authorizeCompositionPath, authorizeDocumentPath } from "../../src/lib/documents/policy";
import {
  migrateComposition,
  validateComposition,
  type PdfComposition,
} from "../../src/lib/documents/pdf-composition";
import {
  PDFCN_CATALOG_VERSION,
  PDFCN_RENDERER,
  PDF_COMPONENTS,
  PDF_THEMES,
} from "../../src/lib/documents/pdf-component-catalog";
import { CABINET_INTERNAL_DIR, virtualPathFromFs } from "../../src/lib/storage/path-utils";
import { DocumentError } from "../../src/lib/documents/errors";
import { fileExists } from "../../src/lib/storage/fs-operations";
import {
  commitBytes,
  readWithRevision,
  stageTempPathFor,
  setBeforeCommitHook,
  setCommitFailedHook,
} from "./persistence";
import {
  recoveryBeforeCommit,
  recoveryCommitFailed,
  noteSessionOpened,
  noteSessionClosed,
  listRecovery,
  readRecoveryBlob,
  saveDraft,
  clearDraft,
  evictIfNeeded,
  recoveryUsage,
} from "./recovery";
import { DocumentBroker, type DocumentSession } from "./broker";
import { selectOcrProvider } from "./ocr/registry";
import type {
  ConvertPlanResult,
  ConvertRequest,
  InspectResult,
  JobInfo,
  JobResult,
  OpenRequest,
  OpenResult,
  PatchRequest,
  PatchResult,
  ReadResult,
  SaveCopyRequest,
  SaveCopyResult,
  SearchResult,
  DocumentActor,
  DocxDocumentModel,
  DocxLoadRequest,
  DocxSaveRequest,
  DocxSaveResult,
  PdfGeometryResult,
} from "../../src/lib/documents/types";

/** Cheap trailer/head scan for a PDF /Encrypt dictionary — good enough to
    gate the editor; PDFium gives the authoritative answer on load. */
function looksEncryptedPdf(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 4096))).toString("latin1");
  const tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 128 * 1024))).toString(
    "latin1",
  );
  return /\/Encrypt\b/.test(head) || /\/Encrypt\b/.test(tail);
}

function validateActor(actor: DocumentActor | undefined): DocumentActor {
  if (actor === undefined) return { kind: "user" };
  if (actor.kind === "user") return actor;
  if (actor.kind === "agent" && typeof actor.id === "string" && actor.id) return actor;
  throw new DocumentError("invalid", "Malformed actor");
}

const PDF_PREVIEW_CACHE_DIR = path.join(CABINET_INTERNAL_DIR, "documents", "preview-cache");
const PDF_GENERATION_META_DIR = path.join(CABINET_INTERNAL_DIR, "documents", "generation");

interface ResolvedTarget {
  session?: DocumentSession;
  virtualPath: string;
  absPath: string;
  format: "docx" | "pdf";
}

export interface DocumentChangeEvent {
  virtualPath: string;
  revision: string;
  actor: DocumentActor;
  op: "patch" | "save" | "save-copy" | "convert" | "restore" | "generate";
}

export interface DocumentServiceCallbacks {
  onDocumentChanged?: (e: DocumentChangeEvent) => void;
  onJobChanged?: (job: JobInfo) => void;
  /**
   * Agent-actor commits only. The daemon wires this to history `recordMutation`
   * + a Next tree-cache invalidation, because agent calls (cabinet-documents)
   * bypass the Next routes that record user mutations. User-actor commits
   * never fire this — the Next route still records those.
   */
  onAgentMutation?: (e: DocumentChangeEvent & { actor: { kind: "agent"; id: string; runId?: string } }) => void;
}

export class DocumentService {
  constructor(
    private readonly broker = new DocumentBroker(),
    private readonly callbacks: DocumentServiceCallbacks = {},
  ) {
    this.broker.start();
    // Step 3: recovery copies ride the persistence hooks.
    setBeforeCommitHook(recoveryBeforeCommit);
    setCommitFailedHook(recoveryCommitFailed);
    this.broker.onJobChange = (job) => this.callbacks.onJobChanged?.(this.broker.jobInfo(job.jobId));
    void evictIfNeeded();
  }

  private changed(ev: DocumentChangeEvent): void {
    try {
      this.callbacks.onDocumentChanged?.(ev);
    } catch {
      /* subscriber errors must not fail the commit */
    }
    if (ev.actor.kind === "agent") {
      try {
        this.callbacks.onAgentMutation?.(
          ev as DocumentChangeEvent & { actor: { kind: "agent"; id: string; runId?: string } },
        );
      } catch {
        /* history/notify failures must not fail the commit */
      }
    }
  }

  // ── open / sessions ───────────────────────────────────────────────────

  async open(input: OpenRequest): Promise<OpenResult> {
    validateActor(input.actor);
    const auth = await authorizeDocumentPath(input.virtualPath, { write: false });
    const { bytes, revision } = await readWithRevision(auth.absPath);
    const session = this.broker.openSession({
      virtualPath: input.virtualPath,
      absPath: auth.absPath,
      format: auth.format,
      revision,
    });
    noteSessionOpened(auth.absPath, session.sessionId);
    // Encrypted PDFs can't be edited by the PDFium patch path — flag them
    // read-only up front so hosts render the fallback viewer instead of
    // letting the user produce saves that will fail.
    const readOnlyReason =
      auth.readOnlyReason ??
      (auth.format === "pdf" && looksEncryptedPdf(bytes)
        ? "PDF is encrypted or password-protected"
        : undefined);
    return {
      sessionId: session.sessionId,
      virtualPath: input.virtualPath,
      format: auth.format,
      revision,
      size: bytes.byteLength,
      capabilities: { edit: !readOnlyReason, convert: auth.format === "pdf" },
      readOnlyReason,
    };
  }

  close(sessionId: string): { closed: true } {
    const session = this.broker.sessions.get(sessionId);
    this.broker.closeSession(sessionId);
    if (session) void noteSessionClosed(session.absPath, sessionId);
    return { closed: true };
  }

  private async resolveTarget(input: {
    sessionId?: string;
    virtualPath?: string;
  }): Promise<ResolvedTarget> {
    if (input.sessionId) {
      const session = this.broker.touchSession(input.sessionId);
      return {
        session,
        virtualPath: session.virtualPath,
        absPath: session.absPath,
        format: session.format,
      };
    }
    if (!input.virtualPath) {
      throw new DocumentError("invalid", "Provide sessionId or virtualPath");
    }
    const auth = await authorizeDocumentPath(input.virtualPath, { write: false });
    return { virtualPath: input.virtualPath, absPath: auth.absPath, format: auth.format };
  }

  // ── read-side ops (serialized on the same mutex for a consistent read) ──

  async inspect(input: { sessionId?: string; virtualPath?: string }): Promise<InspectResult> {
    const t = await this.resolveTarget(input);
    return this.broker.withPathLock(t.absPath, () =>
      this.broker.run("inspect", { inputPath: t.absPath, format: t.format }),
    ) as Promise<InspectResult>;
  }

  async read(input: {
    sessionId?: string;
    virtualPath?: string;
    page?: number;
    paragraphRange?: [number, number];
  }): Promise<ReadResult> {
    const t = await this.resolveTarget(input);
    return this.broker.withPathLock(t.absPath, () =>
      this.broker.run("read", {
        inputPath: t.absPath,
        format: t.format,
        page: input.page,
        paragraphRange: input.paragraphRange,
      }),
    ) as Promise<ReadResult>;
  }

  async pdfPageGeometry(input: {
    sessionId?: string;
    virtualPath?: string;
    pages?: number[];
  }): Promise<PdfGeometryResult> {
    const t = await this.resolveTarget(input);
    if (t.format !== "pdf") {
      throw new DocumentError("unsupported", "Geometry is only available for PDF documents");
    }
    return this.broker.withPathLock(t.absPath, () =>
      this.broker.run("pdfPageGeometry", { inputPath: t.absPath, pages: input.pages }),
    ) as Promise<PdfGeometryResult>;
  }

  async search(input: {
    sessionId?: string;
    virtualPath?: string;
    query: string;
  }): Promise<SearchResult> {
    const t = await this.resolveTarget(input);
    return this.broker.withPathLock(t.absPath, () =>
      this.broker.run("search", { inputPath: t.absPath, format: t.format, query: input.query }),
    ) as Promise<SearchResult>;
  }

  // ── mutations ─────────────────────────────────────────────────────────

  async applyPatch(input: PatchRequest): Promise<PatchResult> {
    validateActor(input.actor);
    const session = this.broker.touchSession(input.sessionId);
    if (!input.baseRevision) {
      throw new DocumentError("invalid", "baseRevision is required");
    }
    await authorizeDocumentPath(session.virtualPath, { write: true });
    return this.broker.withPathLock(session.absPath, async () => {
      const current = await readWithRevision(session.absPath);
      if (current.revision !== input.baseRevision) {
        throw new DocumentError("conflict", "Document changed since baseRevision", {
          currentRevision: current.revision,
        });
      }
      const outputPath = this.broker.tempPathFor(session.absPath);
      const result = (await this.broker.run("applyPatch", {
        inputPath: session.absPath,
        outputPath,
        format: session.format,
        ops: input.ops,
      })) as { applied: number; diagnostics: { index: number; code: string; message: string }[] };
      try {
        const committed = await commitBytes({
          absPath: session.absPath,
          tempPath: outputPath,
          expectedRevision: input.baseRevision,
        });
        session.revision = committed.revision;
        session.lastSeenAt = new Date();
        await this.broker.recordCommit(session.absPath, committed.revision, committed.size);
        this.changed({
          virtualPath: session.virtualPath,
          revision: committed.revision,
          actor: validateActor(input.actor),
          op: "patch",
        });
        return {
          revision: committed.revision,
          applied: result.applied,
          diagnostics: result.diagnostics,
          virtualPath: session.virtualPath,
        };
      } finally {
        await fs.rm(outputPath, { force: true }).catch(() => {});
      }
    });
  }

  // ── DOCX editor model / save plan (Step 4) ─────────────────────────────

  async docxLoad(input: DocxLoadRequest): Promise<DocxDocumentModel> {
    const session = this.broker.touchSession(input.sessionId);
    if (session.format !== "docx") {
      throw new DocumentError("unsupported", "docx load is only available for .docx sessions");
    }
    return this.broker.withPathLock(session.absPath, () =>
      this.broker.run("docxLoad", { inputPath: session.absPath }),
    ) as Promise<DocxDocumentModel>;
  }

  async docxSave(input: DocxSaveRequest): Promise<DocxSaveResult> {
    const actor = validateActor(input.actor);
    const session = this.broker.touchSession(input.sessionId);
    if (session.format !== "docx") {
      throw new DocumentError("unsupported", "docx save is only available for .docx sessions");
    }
    if (!input.baseRevision) {
      throw new DocumentError("invalid", "baseRevision is required");
    }
    await authorizeDocumentPath(session.virtualPath, { write: true });
    return this.broker.withPathLock(session.absPath, async () => {
      const outputPath = this.broker.tempPathFor(session.absPath);
      // The worker re-parses inputPath and applies the plan to CURRENT bytes;
      // commitBytes then rejects the write if they no longer match baseRevision.
      await this.broker.run("docxSave", {
        inputPath: session.absPath,
        outputPath,
        plan: input.plan,
      });
      try {
        const committed = await commitBytes({
          absPath: session.absPath,
          tempPath: outputPath,
          expectedRevision: input.baseRevision,
        });
        session.revision = committed.revision;
        session.lastSeenAt = new Date();
        await this.broker.recordCommit(session.absPath, committed.revision, committed.size);
        this.changed({
          virtualPath: session.virtualPath,
          revision: committed.revision,
          actor,
          op: "save",
        });
        return { revision: committed.revision, virtualPath: session.virtualPath };
      } finally {
        await fs.rm(outputPath, { force: true }).catch(() => {});
      }
    });
  }

  /** Stage path for an upload body — caller streams bytes here, then calls `save`. */
  async prepareSaveTarget(virtualPath: string): Promise<{ absPath: string; tempPath: string }> {
    const auth = await authorizeDocumentPath(virtualPath, { write: true });
    return { absPath: auth.absPath, tempPath: stageTempPathFor(auth.absPath) };
  }

  /** Commit a body previously streamed to `tempPath` (from prepareSaveTarget). */
  async save(input: {
    virtualPath: string;
    baseRevision: string | null;
    tempPath: string;
    actor?: DocumentActor;
  }): Promise<{ revision: string; size: number }> {
    validateActor(input.actor);
    const auth = await authorizeDocumentPath(input.virtualPath, { write: true });
    const committed = await this.broker.withPathLock(auth.absPath, () =>
      commitBytes({
        absPath: auth.absPath,
        tempPath: input.tempPath,
        expectedRevision: input.baseRevision,
      }),
    );
    await this.broker.recordCommit(auth.absPath, committed.revision, committed.size);
    this.changed({
      virtualPath: input.virtualPath,
      revision: committed.revision,
      actor: validateActor(input.actor),
      op: "save",
    });
    return committed;
  }

  async saveCopy(input: SaveCopyRequest): Promise<SaveCopyResult> {
    validateActor(input.actor);
    const src = await authorizeDocumentPath(input.virtualPath, { write: false });
    const { bytes, revision } = await readWithRevision(src.absPath);
    if (input.baseRevision !== revision) {
      throw new DocumentError("conflict", "Document changed since baseRevision", {
        currentRevision: revision,
      });
    }
    const dest = await this.collisionFreePath(input.destinationVirtualPath);
    const committed = await this.broker.withPathLock(dest.absPath, () =>
      commitBytes({ absPath: dest.absPath, bytes, expectedRevision: null }),
    );
    await this.broker.recordCommit(dest.absPath, committed.revision, committed.size);
    this.changed({
      virtualPath: dest.virtualPath,
      revision: committed.revision,
      actor: validateActor(input.actor),
      op: "save-copy",
    });
    return { virtualPath: dest.virtualPath, revision: committed.revision, size: committed.size };
  }

  /**
   * Next free path for `virtualPath`: if taken, inserts ` (2)`, ` (3)`… before
   * the extension. The returned path has already passed write authorization.
   */
  private async collisionFreePath(virtualPath: string): Promise<{ virtualPath: string; absPath: string }> {
    const ext = path.posix.extname(virtualPath);
    const stem = virtualPath.slice(0, virtualPath.length - ext.length);
    for (let i = 0; i < 1000; i++) {
      const candidate = i === 0 ? virtualPath : `${stem} (${i + 1})${ext}`;
      const auth = await authorizeDocumentPath(candidate, { write: true });
      if (!(await fileExists(auth.absPath))) {
        return { virtualPath: candidate, absPath: auth.absPath };
      }
    }
    throw new DocumentError("invalid", "Could not find a free destination name");
  }

  // ── convert job ─────────────────────────────────────────────────────────

  async convert(input: ConvertRequest): Promise<{ jobId: string }> {
    const actor = validateActor(input.actor);
    const src = await authorizeDocumentPath(input.virtualPath, { write: false });
    if (src.format !== "pdf") {
      throw new DocumentError("unsupported", "Only PDF sources can be converted to DOCX");
    }
    const { revision } = await readWithRevision(src.absPath);
    if (input.baseRevision !== revision) {
      throw new DocumentError("conflict", "Document changed since baseRevision", {
        currentRevision: revision,
      });
    }
    const ext = path.posix.extname(input.virtualPath);
    const stem = input.virtualPath.slice(0, input.virtualPath.length - ext.length);
    // Read-only source (gdrive:/read-only mount): the sibling can't be written,
    // so the destination defaults to a Converted/ folder at the cabinet root.
    const defaultDest = src.readOnlyReason ? `Converted/${stem.split("/").pop()}.docx` : `${stem}.docx`;
    const dest = await this.collisionFreePath(input.destinationVirtualPath ?? defaultDest);

    const outputPath = this.broker.tempPathFor(dest.absPath);
    const job = this.broker.createJob("convert-pdf-docx", [outputPath]);
    this.broker.onJobChange?.(job); // queued
    void this.runConvertJob(job.jobId, src.absPath, outputPath, dest, actor, {
      languageHints: input.languageHints,
      acknowledgeDegraded: input.acknowledgeDegraded,
    });
    return { jobId: job.jobId };
  }

  /** Destination + scan preview for the convert dialog. */
  async convertPlan(virtualPath: string): Promise<ConvertPlanResult> {
    const src = await authorizeDocumentPath(virtualPath, { write: false });
    if (src.format !== "pdf") {
      throw new DocumentError("unsupported", "Only PDF sources can be converted to DOCX");
    }
    const ext = path.posix.extname(virtualPath);
    const stem = virtualPath.slice(0, virtualPath.length - ext.length);
    const wanted = src.readOnlyReason ? `Converted/${stem.split("/").pop()}.docx` : `${stem}.docx`;
    const dest = await this.collisionFreePath(wanted);
    const scan = (await this.broker.run("pdfConvertPlan", {
      inputPath: src.absPath,
    })) as { pageCount: number; scannedPages: number[] };
    return {
      destinationVirtualPath: dest.virtualPath,
      pageCount: scan.pageCount,
      scannedPages: scan.scannedPages,
      ocr: await this.ocrCapabilities(),
    };
  }

  async ocrCapabilities() {
    return selectOcrProvider().capabilities();
  }

  private async runConvertJob(
    jobId: string,
    inputPath: string,
    outputPath: string,
    dest: { virtualPath: string; absPath: string },
    actor: DocumentActor,
    opts: { languageHints?: string[]; acknowledgeDegraded?: boolean } = {},
  ): Promise<void> {
    const job = this.broker.jobs.get(jobId)!;
    try {
      const meta = (await this.broker.run(
        "convert",
        {
          inputPath,
          outputPath,
          languageHints: opts.languageHints,
          acknowledgeDegraded: opts.acknowledgeDegraded,
        },
        job,
      )) as {
        pageCount: number;
        scannedDocument: boolean;
        warnings: string[];
        pageResults?: unknown[];
        ocr?: { provider: string; version: string } | null;
        degraded?: boolean;
      };
      if (job.status === "cancelled") return;
      // Commit under the destination lock; if the name was taken meanwhile,
      // fall through to the next collision-free name.
      await this.broker.withPathLock(dest.absPath, async () => {
        let target = dest;
        if (await fileExists(dest.absPath)) {
          target = await this.collisionFreePath(dest.virtualPath);
        }
        const committed = await commitBytes({
          absPath: target.absPath,
          tempPath: outputPath,
          expectedRevision: null,
        });
        job.result = {
          virtualPath: target.virtualPath,
          revision: committed.revision,
          size: committed.size,
          pageCount: meta.pageCount,
          pageResults: meta.pageResults as JobResult["pageResults"],
          scannedDocument: meta.scannedDocument,
          warnings: meta.warnings,
          ocr: meta.ocr ?? null,
          degraded: meta.degraded,
          // Agent-actor converts are recorded daemon-side via onAgentMutation —
          // mark them so a Next job poll doesn't record a second mutation.
          mutationRecorded: actor.kind === "agent",
        };
        job.status = "done";
        await this.broker.recordCommit(target.absPath, committed.revision, committed.size);
        this.changed({
          virtualPath: target.virtualPath,
          revision: committed.revision,
          actor,
          op: "convert",
        });
        this.broker.onJobChange?.(job);
      });
    } catch (err) {
      if (job.status === "cancelled") return;
      job.status = "failed";
      const e = err instanceof DocumentError ? err : new DocumentError("worker-failed", String(err));
      job.error = { code: e.code, message: e.message, details: e.details };
      this.broker.onJobChange?.(job);
      await fs.rm(outputPath, { force: true }).catch(() => {});
    }
  }

  jobStatus(jobId: string): JobInfo {
    return this.broker.jobInfo(jobId);
  }

  // ── pdf composition (Step 7a / PDFCN) ─────────────────────────────────

  /** Component/theme catalog for the UI palette and `pdf-catalog` agent cmd. */
  pdfCompositionCatalog() {
    return {
      catalogVersion: PDFCN_CATALOG_VERSION,
      themes: [...PDF_THEMES],
      components: PDF_COMPONENTS,
    };
  }

  pdfCompositionValidate(input: { composition?: unknown; virtualPath?: string }) {
    if (typeof input.virtualPath === "string" && input.virtualPath) {
      return this.pdfCompositionValidatePath(input.virtualPath);
    }
    return validateComposition(migrateComposition(input.composition));
  }

  private async pdfCompositionValidatePath(virtualPath: string) {
    const auth = await authorizeCompositionPath(virtualPath, { write: false });
    const { bytes } = await readWithRevision(auth.absPath);
    try {
      return validateComposition(migrateComposition(JSON.parse(bytes.toString("utf8"))));
    } catch {
      return {
        ok: false as const,
        errors: [{ path: "$", code: "shape" as const, message: "file is not valid JSON" }],
      };
    }
  }

  private async requireCompositionSource(virtualPath: string) {
    if (typeof virtualPath !== "string" || !virtualPath.endsWith(".pdf.source.json")) {
      throw new DocumentError("invalid", "Composition sources must end in .pdf.source.json");
    }
    const auth = await authorizeCompositionPath(virtualPath, { write: false });
    const { bytes, revision } = await readWithRevision(auth.absPath);
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new DocumentError("invalid", "Composition source is not valid JSON");
    }
    const validated = validateComposition(migrateComposition(parsed));
    if (!validated.ok) {
      throw new DocumentError("invalid", "Composition failed validation", {
        errors: validated.errors,
      });
    }
    return { auth, sourceRevision: revision, composition: validated.value as PdfComposition };
  }

  /**
   * Validate + commit a `.pdf.source.json` through the daemon so agents never
   * hand-write JSON that later fails validation. `baseRevision` optional;
   * create uses expectedRevision null, update uses the current revision.
   */
  async pdfCompositionSaveSource(input: {
    virtualPath: string;
    composition: unknown;
    baseRevision?: string;
    actor?: DocumentActor;
  }): Promise<{ revision: string; size: number }> {
    const actor = validateActor(input.actor);
    if (typeof input.virtualPath !== "string" || !input.virtualPath.endsWith(".pdf.source.json")) {
      throw new DocumentError("invalid", "Composition sources must end in .pdf.source.json");
    }
    const validated = validateComposition(migrateComposition(input.composition));
    if (!validated.ok) {
      throw new DocumentError("invalid", "Composition failed validation", {
        errors: validated.errors,
      });
    }
    const auth = await authorizeCompositionPath(input.virtualPath, { write: true });
    const text = JSON.stringify(validated.value, null, 2) + "\n";
    await fs.mkdir(path.dirname(auth.absPath), { recursive: true });
    return this.broker.withPathLock(auth.absPath, async () => {
      const exists = await fileExists(auth.absPath);
      let expected: string | null = null;
      if (exists) {
        const current = await readWithRevision(auth.absPath);
        expected = current.revision;
        if (input.baseRevision !== undefined && input.baseRevision !== current.revision) {
          throw new DocumentError("conflict", "Document changed since baseRevision", {
            currentRevision: current.revision,
          });
        }
      }
      const tempPath = this.broker.tempPathFor(auth.absPath);
      await fs.writeFile(tempPath, text);
      const committed = await commitBytes({
        absPath: auth.absPath,
        tempPath,
        expectedRevision: expected,
        signatureCheck: "json",
      });
      await this.broker.recordCommit(auth.absPath, committed.revision, committed.size);
      this.changed({
        virtualPath: input.virtualPath,
        revision: committed.revision,
        actor,
        op: "save",
      });
      return committed;
    });
  }

  /**
   * Render a `.pdf.source.json` composition to PDF.
   * mode=preview → PDF lands in the render cache; result carries `previewKey`.
   * mode=publish → commits `<stem>.pdf` next to the source and records
   * generation metadata; refuses to clobber a hand-modified output unless
   * `replace` (overwrite) or `saveAsCopy` (collision-free copy) is passed.
   */
  async pdfCompositionRender(input: {
    sourceVirtualPath: string;
    mode: "preview" | "publish";
    actor?: DocumentActor;
    replace?: boolean;
    saveAsCopy?: boolean;
    destinationVirtualPath?: string;
  }): Promise<{ jobId: string }> {
    const actor = validateActor(input.actor);
    const { auth, sourceRevision, composition } = await this.requireCompositionSource(
      input.sourceVirtualPath,
    );
    const assetsDir = path.dirname(auth.absPath);
    // Authorize declared assets up front: each must resolve inside the
    // source's folder (the worker enforces the same boundary) and be inside
    // an authorized root; escapes fail here as `unauthorized`, not warnings.
    const assetStats: string[] = [];
    for (const [key, asset] of Object.entries(composition.assets ?? {})) {
      const abs = path.resolve(assetsDir, asset.path);
      if (abs !== assetsDir && !abs.startsWith(assetsDir + path.sep)) {
        throw new DocumentError("unauthorized", `Asset "${key}" escapes the source folder`);
      }
      await authorizeCompositionPath(virtualPathFromFs(abs), { write: false });
      const stat = await fs.stat(abs).catch(() => null);
      assetStats.push(`${key}:${abs}:${stat?.size ?? 0}:${stat?.mtimeMs ?? 0}`);
    }
    assetStats.sort();

    const previewKey = createHash("sha256")
      .update(
        [
          sourceRevision,
          PDFCN_CATALOG_VERSION,
          PDFCN_RENDERER.version,
          composition.theme,
          ...assetStats,
        ].join("\n"),
      )
      .digest("hex");

    if (input.mode === "preview") {
      const cacheFile = path.join(PDF_PREVIEW_CACHE_DIR, `${previewKey}.pdf`);
      if (await fileExists(cacheFile)) {
        const job = this.broker.createJob("pdf-render", []);
        job.status = "done";
        job.result = { previewKey, cached: true };
        this.broker.onJobChange?.(job);
        return { jobId: job.jobId };
      }
      // outputPaths includes the cache file so a cancelled render doesn't
      // leave a truncated PDF behind to be served as a later cache hit.
      const job = this.broker.createJob("pdf-render", [cacheFile]);
      this.broker.onJobChange?.(job);
      void this.runPdfRenderJob(job.jobId, composition, assetsDir, cacheFile, {
        mode: "preview",
        actor,
        sourceVirtualPath: input.sourceVirtualPath,
        sourceRevision,
        previewKey,
      });
      return { jobId: job.jobId };
    }

    // publish
    const stem = input.sourceVirtualPath.slice(
      0,
      input.sourceVirtualPath.length - ".source.json".length,
    );
    const destVirtual = input.destinationVirtualPath ?? stem;
    if (!destVirtual.toLowerCase().endsWith(".pdf")) {
      throw new DocumentError("invalid", "Publish destination must be a .pdf path");
    }
    const dest = await authorizeDocumentPath(destVirtual, { write: true });
    const outputPath = this.broker.tempPathFor(dest.absPath);
    const job = this.broker.createJob("pdf-render", [outputPath]);
    this.broker.onJobChange?.(job);
    void this.runPdfRenderJob(job.jobId, composition, assetsDir, outputPath, {
      mode: "publish",
      actor,
      sourceVirtualPath: input.sourceVirtualPath,
      sourceRevision,
      dest: { virtualPath: dest.virtualPath, absPath: dest.absPath },
      replace: input.replace === true,
      saveAsCopy: input.saveAsCopy === true,
    });
    return { jobId: job.jobId };
  }

  /** Streamed preview bytes for GET /documents/preview/:key (hex sha256 only). */
  async pdfPreviewFile(key: string): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(key)) {
      throw new DocumentError("invalid", "Malformed preview key");
    }
    const p = path.join(PDF_PREVIEW_CACHE_DIR, `${key}.pdf`);
    if (!(await fileExists(p))) {
      throw new DocumentError("not-found", "Preview not found or expired");
    }
    return p;
  }

  private async runPdfRenderJob(
    jobId: string,
    composition: PdfComposition,
    assetsDir: string,
    outputPath: string,
    ctx: {
      mode: "preview" | "publish";
      actor: DocumentActor;
      sourceVirtualPath: string;
      sourceRevision: string;
      previewKey?: string;
      dest?: { virtualPath: string; absPath: string };
      replace?: boolean;
      saveAsCopy?: boolean;
    },
  ): Promise<void> {
    const job = this.broker.jobs.get(jobId)!;
    try {
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      const meta = (await this.broker.run(
        "pdfCompositionRender",
        { composition, assetsDir, outputPath, mode: ctx.mode },
        job,
      )) as {
        pageCount: number;
        pages: { index: number; widthPt: number; heightPt: number }[];
        warnings: { nodeId?: string; code: string; message: string }[];
        renderer: { id: string; version: string };
        byteLength: number;
      };
      if (job.status === "cancelled") return;

      if (ctx.mode === "preview") {
        await this.evictPreviewCache();
        job.result = {
          previewKey: ctx.previewKey,
          cached: false,
          pageCount: meta.pageCount,
          warnings: meta.warnings.map((w) => w.message),
        };
        job.status = "done";
        this.broker.onJobChange?.(job);
        return;
      }

      const dest = ctx.dest!;
      await this.broker.withPathLock(dest.absPath, async () => {
        let target = dest;
        let expectedRevision: string | null = null;
        if (await fileExists(dest.absPath)) {
          const current = await readWithRevision(dest.absPath);
          const meta2 = await this.readGenerationMeta(ctx.sourceVirtualPath);
          const currentHash = createHash("sha256").update(current.bytes).digest("hex");
          const generated = meta2?.outputVirtualPath === dest.virtualPath && meta2.outputHash === currentHash;
          if (!generated) {
            if (ctx.saveAsCopy) {
              target = await this.collisionFreePath(dest.virtualPath);
            } else if (!ctx.replace) {
              throw new DocumentError(
                "conflict",
                "Output PDF was modified outside the generator — use replace or copy",
                { reason: "output-modified", currentRevision: current.revision },
              );
            } else {
              expectedRevision = current.revision;
            }
          } else {
            expectedRevision = current.revision;
          }
        }
        const committed = await commitBytes({
          absPath: target.absPath,
          tempPath: outputPath,
          expectedRevision,
        });
        const outBytes = await fs.readFile(target.absPath);
        const outputHash = createHash("sha256").update(outBytes).digest("hex");
        job.result = {
          virtualPath: target.virtualPath,
          revision: committed.revision,
          size: committed.size,
          pageCount: meta.pageCount,
          warnings: meta.warnings.map((w) => w.message),
          mutationRecorded: ctx.actor.kind === "agent",
        };
        job.status = "done";
        await this.broker.recordCommit(target.absPath, committed.revision, committed.size);
        // Metadata AFTER the commit; a crash between them is detected on the
        // next publish via the outputHash mismatch (output → unknown →
        // conflict/copy/replace).
        await this.writeGenerationMeta({
          documentId: composition.documentId,
          sourceVirtualPath: ctx.sourceVirtualPath,
          outputVirtualPath: target.virtualPath,
          sourceRevision: ctx.sourceRevision,
          outputRevision: committed.revision,
          outputHash,
          catalogVersion: PDFCN_CATALOG_VERSION,
          rendererVersion: meta.renderer.version,
          renderedAt: new Date().toISOString(),
        });
        this.changed({
          virtualPath: target.virtualPath,
          revision: committed.revision,
          actor: ctx.actor,
          op: "generate",
        });
        this.broker.onJobChange?.(job);
      });
    } catch (err) {
      if (job.status === "cancelled") return;
      job.status = "failed";
      const e = err instanceof DocumentError ? err : new DocumentError("worker-failed", String(err));
      job.error = { code: e.code, message: e.message, details: e.details };
      this.broker.onJobChange?.(job);
      await fs.rm(outputPath, { force: true }).catch(() => {});
    }
  }

  /** Staleness/modification report for a composition source + its output. */
  async pdfCompositionStatus(virtualPath: string): Promise<{
    sourceRevision: string;
    output?: {
      virtualPath: string;
      revision: string;
      stale: boolean;
      modified: boolean;
    };
  }> {
    const { sourceRevision } = await this.requireCompositionSource(virtualPath);
    const meta = await this.readGenerationMeta(virtualPath);
    if (!meta) return { sourceRevision };
    let outAuth;
    try {
      outAuth = await authorizeDocumentPath(meta.outputVirtualPath, { write: false });
    } catch {
      return { sourceRevision };
    }
    if (!(await fileExists(outAuth.absPath))) return { sourceRevision };
    const current = await readWithRevision(outAuth.absPath);
    const hash = createHash("sha256").update(current.bytes).digest("hex");
    return {
      sourceRevision,
      output: {
        virtualPath: meta.outputVirtualPath,
        revision: current.revision,
        stale: meta.sourceRevision !== sourceRevision,
        modified: hash !== meta.outputHash,
      },
    };
  }

  private generationMetaPath(sourceVirtualPath: string): string {
    const key = createHash("sha256").update(sourceVirtualPath).digest("hex");
    return path.join(PDF_GENERATION_META_DIR, `${key}.json`);
  }

  private async readGenerationMeta(sourceVirtualPath: string): Promise<{
    documentId: string;
    sourceVirtualPath: string;
    outputVirtualPath: string;
    sourceRevision: string;
    outputRevision: string;
    outputHash: string;
  } | null> {
    try {
      const raw = await fs.readFile(this.generationMetaPath(sourceVirtualPath), "utf8");
      const m = JSON.parse(raw);
      return m && m.sourceVirtualPath === sourceVirtualPath ? m : null;
    } catch {
      return null;
    }
  }

  private async writeGenerationMeta(meta: Record<string, unknown>): Promise<void> {
    await fs.mkdir(PDF_GENERATION_META_DIR, { recursive: true });
    const p = this.generationMetaPath(String(meta.sourceVirtualPath));
    const tmp = `${p}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(meta, null, 2));
    await fs.rename(tmp, p);
  }

  private async evictPreviewCache(): Promise<void> {
    const CAP = 200 * 1024 * 1024;
    try {
      const entries = await fs.readdir(PDF_PREVIEW_CACHE_DIR, { withFileTypes: true });
      const files: { p: string; size: number; mtimeMs: number }[] = [];
      let total = 0;
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith(".pdf")) continue;
        const p = path.join(PDF_PREVIEW_CACHE_DIR, e.name);
        const s = await fs.stat(p).catch(() => null);
        if (!s) continue;
        total += s.size;
        files.push({ p, size: s.size, mtimeMs: s.mtimeMs });
      }
      if (total <= CAP) return;
      files.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const f of files) {
        if (total <= CAP) break;
        await fs.rm(f.p, { force: true }).catch(() => {});
        total -= f.size;
      }
    } catch {
      /* cache hygiene must not fail renders */
    }
  }

  // ── revision refresh ──────────────────────────────────────────────────

  async revision(virtualPath: string): Promise<{ revision: string; size: number; mtimeMs: number }> {
    const auth = await authorizeDocumentPath(virtualPath, { write: false });
    return this.broker.revisionFor(auth.absPath);
  }

  // ── recovery copies & drafts ──────────────────────────────────────────

  async listRecovery(virtualPath: string) {
    const auth = await authorizeDocumentPath(virtualPath, { write: false });
    return listRecovery(auth.absPath);
  }

  async restoreRecovery(input: {
    virtualPath: string;
    revision: string;
    baseRevision: string;
    actor?: DocumentActor;
  }): Promise<{ revision: string; size: number }> {
    const actor = validateActor(input.actor);
    const auth = await authorizeDocumentPath(input.virtualPath, { write: true });
    const bytes = await readRecoveryBlob(auth.absPath, input.revision);
    const committed = await this.broker.withPathLock(auth.absPath, () =>
      commitBytes({
        absPath: auth.absPath,
        bytes,
        expectedRevision: input.baseRevision,
      }),
    );
    await this.broker.recordCommit(auth.absPath, committed.revision, committed.size);
    this.changed({
      virtualPath: input.virtualPath,
      revision: committed.revision,
      actor,
      op: "restore",
    });
    return committed;
  }

  /** Stage a draft body (caller streams to tempPath, then calls saveDraft). */
  async prepareDraftTarget(virtualPath: string): Promise<{ absPath: string; tempPath: string }> {
    const auth = await authorizeDocumentPath(virtualPath, { write: false });
    return { absPath: auth.absPath, tempPath: stageTempPathFor(auth.absPath) };
  }

  async saveDraft(input: {
    virtualPath: string;
    tempPath: string;
    sessionId?: string;
    baseRevision?: string;
  }): Promise<{ revision: string; size: number }> {
    const auth = await authorizeDocumentPath(input.virtualPath, { write: false });
    return saveDraft({
      absPath: auth.absPath,
      virtualPath: input.virtualPath,
      tempPath: input.tempPath,
      sessionId: input.sessionId,
      baseRevision: input.baseRevision,
    });
  }

  async clearDraft(virtualPath: string): Promise<{ cleared: true }> {
    const auth = await authorizeDocumentPath(virtualPath, { write: false });
    await clearDraft(auth.absPath);
    return { cleared: true };
  }



  markJobRecorded(jobId: string): JobInfo {
    return this.broker.markJobRecorded(jobId);
  }

  cancel(jobId: string): JobInfo {
    return this.broker.cancelJob(jobId);
  }

  /** Test/diagnostic hook: run a raw op on the worker pool. */
  runWorkerOp(op: string, args: Record<string, unknown>): Promise<unknown> {
    return this.broker.run(op, args);
  }

  async health(): Promise<{
    workers: number;
    sessions: number;
    jobs: number;
    queue: number;
    recoveryBytes: number;
    recoveryDocuments: number;
  }> {
    const usage = await recoveryUsage();
    return { ...this.broker.stats(), recoveryBytes: usage.bytes, recoveryDocuments: usage.documents };
  }

  async shutdown(): Promise<void> {
    await this.broker.shutdown();
  }
}


