"use client";

/**
 * The PDF editor frame. Runs inside `/document-editor#format=pdf` — the
 * same-origin iframe the host viewer embeds. Talks to the host over
 * `frame-bridge` postMessage and to the server over `/api/documents/*` only.
 *
 * Pages render browser-side with pdf.js (worker/cmaps/fonts from
 * /document-editor/pdfjs/); edits accumulate client-side in the vendored
 * GenOffice edit model (TextEditInput/TextInsertInput/ImageEditInput) and
 * save as one atomic `patch` op — PDFium never runs in the browser.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist";

import { createFrameBridge, type BridgeMessage } from "@/lib/documents/frame-bridge";
import type {
  DocumentPatchOp,
  PdfGeometryResult,
  PdfPageGeometry,
  PdfTextEdit,
  PdfTextInsert,
  PdfImageEdit,
  Rect4,
} from "@/lib/documents/types";
import { useLocale } from "@/i18n/use-locale";

import { PdfPage } from "../../../vendor/genoffice/apps/pdf/renderer/PdfPage";
import { ImageEditLayer, type LocalImageEdit } from "../../../vendor/genoffice/apps/pdf/renderer/ImageEditLayer";
import {
  geomDispSize,
  pdfRectToCss,
  pdfToView,
  viewToPdf,
  type PageGeom,
} from "../../../vendor/genoffice/apps/pdf/renderer/annotations";
import {
  groupPageBlocks,
  reflowOverflows,
  type TextBlock,
} from "../../../vendor/genoffice/apps/pdf/renderer/text-block";
import {
  joinBlockLines,
  measurePt,
  wrapText,
} from "../../../vendor/genoffice/apps/pdf/renderer/text-wrap";
import { buildSearchIndex } from "../../../vendor/genoffice/apps/pdf/renderer/search";
import {
  textEditPreviewContent,
  textEditPreviewParts,
  textInsertPreviewStyle,
  unionCover,
  inflateCss,
  type LocalTextEdit,
  type LocalTextInsert,
} from "../../../vendor/genoffice/apps/pdf/renderer/text-edit-preview";
import { DOC_OPTS } from "../../../vendor/genoffice/apps/pdf/renderer/view-config";
import type { PageImageRef } from "../../../vendor/genoffice/apps/pdf/shared/ipc";
import "../../../vendor/genoffice/apps/pdf/renderer/styles.css";
import "../../../app/document-editor/document-editor.css";

GlobalWorkerOptions.workerSrc = "/document-editor/pdfjs/pdf.worker.min.mjs";

type Tool = "select" | "editText" | "insertText" | "image";

interface InitMsg {
  virtualPath: string;
  sessionId: string;
  revision: string;
  readOnlyReason?: string;
  theme: "light" | "dark";
  locale: string;
}

interface BlockDraft {
  pageIndex: number;
  rect: Rect4;
  oldText: string;
  fontSize: number;
  value: string;
  editId?: string;
  block: {
    leftPt: number;
    firstBaseline: number;
    widthPt: number;
    lineHeight: number;
    align: "left" | "center" | "right";
    bottomPt: number;
  };
}

interface InsertDraft {
  pageIndex: number;
  origin: [number, number];
  rotate: number;
  value: string;
}

interface PendingImage {
  /** base64 PNG (no data: prefix) */
  png: string;
  widthPx: number;
  heightPx: number;
}

interface Diag {
  message: string;
  details?: Record<string, unknown>;
}

const IMAGE_FILE_CAP = 20 * 1024 * 1024;

const newId = () => `e${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;

/** oldRect of an image op when it has one (insert ops don't). */
const oldRectOf = (i: PdfImageEdit): Rect4 | undefined =>
  "oldRect" in i ? i.oldRect : undefined;

const rectKey = (r: readonly number[]): string => r.map((v) => v.toFixed(2)).join(",");

async function apiPost<T>(op: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/documents/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error ?? `Request failed (${res.status})`) as Error & {
      code?: string;
      status?: number;
      currentRevision?: string;
      details?: Record<string, unknown>;
    };
    err.code = json.code;
    err.status = res.status;
    err.currentRevision = json.currentRevision;
    err.details = json.details;
    throw err;
  }
  return json as T;
}

async function fetchBytes(virtualPath: string, revision?: string): Promise<{
  bytes: ArrayBuffer;
  revision: string;
}> {
  const qs = new URLSearchParams({ path: virtualPath });
  if (revision) qs.set("revision", revision);
  const res = await fetch(`/api/documents/asset?${qs}`);
  if (res.status === 409) {
    const json = await res.json().catch(() => ({}));
    const err = new Error("Document changed on disk") as Error & {
      code?: string;
      currentRevision?: string;
    };
    err.code = "conflict";
    err.currentRevision = json.currentRevision;
    throw err;
  }
  if (!res.ok) throw new Error(`Could not load document (${res.status})`);
  return { bytes: await res.arrayBuffer(), revision: res.headers.get("etag")?.replaceAll('"', "") ?? "" };
}

/** Translate a PDF-space rect into the page's crop-box frame (upstream helpers
    assume the user-space origin is the visible origin). */
const cropRect = (r: Rect4, crop: Rect4): Rect4 => [
  r[0] - crop[0],
  r[1] - crop[1],
  r[2] - crop[0],
  r[3] - crop[1],
];

function rectsOverlap(a: readonly number[], b: readonly number[]): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

export default function PdfEditorFrame() {
  const { t } = useLocale();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const imageFileRef = useRef<HTMLInputElement | null>(null);
  const replaceFileRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ currentRevision?: string } | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [scale, setScale] = useState(1.25);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [geometry, setGeometry] = useState<PdfGeometryResult | null>(null);
  const [pageSizes, setPageSizes] = useState<{ width: number; height: number }[]>([]);
  const [baseRots, setBaseRots] = useState<number[]>([]);
  const [pageBlocks, setPageBlocks] = useState<Map<number, TextBlock[]>>(new Map());
  const [hoverBlock, setHoverBlock] = useState<{ pageIndex: number; block: TextBlock; editable: boolean; reason?: string } | null>(null);
  const [draft, setDraft] = useState<BlockDraft | null>(null);
  const [insertDraft, setInsertDraft] = useState<InsertDraft | null>(null);
  const [textEdits, setTextEdits] = useState<LocalTextEdit[]>([]);
  const [textInserts, setTextInserts] = useState<LocalTextInsert[]>([]);
  const [imageEdits, setImageEdits] = useState<LocalImageEdit[]>([]);
  const [selImage, setSelImage] = useState<{ pageIndex: number; rect: Rect4 } | null>(null);
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  const [diag, setDiag] = useState<Diag | null>(null);
  const [signedDismissed, setSignedDismissed] = useState(false);

  const st = useRef({
    bridge: null as ReturnType<typeof createFrameBridge> | null,
    init: null as InitMsg | null,
    revision: "",
    dirty: false,
    dirtyGeneration: 0,
    savedGeneration: 0,
    saving: false,
    readOnly: false,
    autosaveTimer: null as ReturnType<typeof setTimeout> | null,
    draftTimer: null as ReturnType<typeof setTimeout> | null,
    disposed: false,
    /** A revision-changed notice received while a save was in flight. */
    deferredRevision: null as string | null,
  });
  // Latest edit lists for the async save path.
  const editsRef = useRef({ textEdits, textInserts, imageEdits });
  editsRef.current = { textEdits, textInserts, imageEdits };
  const dirtyEdits = textEdits.length + textInserts.length + imageEdits.length > 0 || draft !== null || insertDraft !== null;

  const sendState = useCallback((extra?: Record<string, unknown>) => {
    const s = st.current;
    s.bridge?.send("state", { dirty: s.dirty, saving: s.saving, ...extra });
  }, []);

  const markDirty = useCallback(() => {
    const s = st.current;
    s.dirty = true;
    s.dirtyGeneration++;
    sendState();
    if (s.autosaveTimer) clearTimeout(s.autosaveTimer);
    if (s.draftTimer) clearTimeout(s.draftTimer);
    s.autosaveTimer = setTimeout(() => void doSaveRef.current("autosave"), 2000);
    s.draftTimer = setTimeout(() => void pushDraftRef.current(), 5000);
  }, [sendState]);

  // ── geometry-derived per-page state ──────────────────────────────────────

  const pageGeom = useCallback(
    (pageIndex: number): PageGeom => {
      const s = pageSizes[pageIndex] ?? { width: 0, height: 0 };
      return { pw: s.width, ph: s.height, rot: baseRots[pageIndex] ?? 0 };
    },
    [pageSizes, baseRots],
  );

  const pageCrop = useCallback(
    (pageIndex: number): Rect4 => geometry?.pages.find((p) => p.index === pageIndex)?.cropBox ?? [0, 0, 0, 0],
    [geometry],
  );

  const pageImages = useMemo(() => {
    const out = new Map<number, PageImageRef[]>();
    for (const p of geometry?.pages ?? []) {
      out.set(
        p.index,
        p.images.map((im) => ({ pageIndex: p.index, rect: [...im.bounds] as Rect4, aboveText: im.aboveText })),
      );
    }
    return out;
  }, [geometry]);

  /** Editable-line coverage: a pdf.js block is editable when editable
      server-side lines cover ≥50% of its area. */
  const blockEditable = useCallback(
    (pageIndex: number, block: TextBlock): { editable: boolean; reason?: string } => {
      const page = geometry?.pages.find((p) => p.index === pageIndex);
      if (!page) return { editable: true };
      const blockArea = Math.max((block.rect[2] - block.rect[0]) * (block.rect[3] - block.rect[1]), 1e-6);
      let covered = 0;
      let reason: string | undefined;
      for (const l of page.textLines) {
        const ov = rectsOverlap(block.rect, l.bounds);
        if (ov <= 0) continue;
        if (l.editable) covered += ov;
        else reason = l.reason;
      }
      return covered / blockArea >= 0.5 ? { editable: true } : { editable: false, reason };
    },
    [geometry],
  );

  // ── document loading ────────────────────────────────────────────────────

  const loadDocument = useCallback(async () => {
    const s = st.current;
    const init = s.init;
    if (!init) return;
    const [{ bytes }, geom] = await Promise.all([
      fetchBytes(init.virtualPath),
      apiPost<PdfGeometryResult>("pdf/geometry", { sessionId: init.sessionId }),
    ]);
    const loaded = await getDocument({ data: bytes.slice(0), ...DOC_OPTS }).promise;
    const sizes: { width: number; height: number }[] = [];
    const rots: number[] = [];
    for (let n = 1; n <= loaded.numPages; n++) {
      const page = await loaded.getPage(n);
      const vp = page.getViewport({ scale: 1, rotation: 0 });
      sizes.push({ width: vp.width, height: vp.height });
      rots.push(page.rotate ?? 0);
    }
    const index = await buildSearchIndex(loaded);
    const blocks = new Map<number, TextBlock[]>();
    index.forEach((entry, i) => blocks.set(i, groupPageBlocks(entry)));
    void (doc as unknown as { destroy?: () => Promise<void> } | null)?.destroy?.();
    setDoc(loaded);
    setGeometry(geom);
    setPageSizes(sizes);
    setBaseRots(rots);
    setPageBlocks(blocks);
    setDraft(null);
    setInsertDraft(null);
    setSelImage(null);
    setHoverBlock(null);
    setDiag(null);
  }, [doc]);

  /** Discard all pending edits (reload-latest path after explicit confirm). */
  const resetEdits = useCallback(() => {
    setTextEdits([]);
    setTextInserts([]);
    setImageEdits([]);
    setDraft(null);
    setInsertDraft(null);
    setSelImage(null);
  }, []);

  const pendingOps = useCallback((): DocumentPatchOp[] => {
    const e = editsRef.current;
    return [
      ...e.textEdits.map((te) => ({ kind: "pdfTextEdit", edit: te.input as PdfTextEdit }) as DocumentPatchOp),
      ...e.textInserts.map((ti) => ({ kind: "pdfTextInsert", insert: ti.input as PdfTextInsert }) as DocumentPatchOp),
      ...e.imageEdits.map((ie) => ({ kind: "pdfImageOp", op: ie.input as PdfImageEdit }) as DocumentPatchOp),
    ];
  }, []);

  // ── save ────────────────────────────────────────────────────────────────

  /**
   * Apply a revision-changed notice: reload a clean document, flag a
   * conflict when local edits would be overwritten. Callers must defer
   * while a save is in flight — the daemon echoes our own commits and the
   * comparison is only meaningful against the post-save revision.
   */
  const handleIncomingRevision = useCallback(
    (incoming: string) => {
      const s = st.current;
      if (!s.dirty && incoming !== s.revision) {
        s.revision = incoming;
        resetEdits();
        void loadDocument().then(() => setConflict(null)).catch(() => {});
      } else if (incoming !== s.revision) {
        setConflict({ currentRevision: incoming });
        s.bridge?.send("conflict", { currentRevision: incoming });
      }
    },
    [loadDocument, resetEdits],
  );

  const doSave = useCallback(
    async (reason: "manual" | "autosave" | "flush"): Promise<void> => {
      const s = st.current;
      const ops = pendingOps();
      if (s.saving || s.disposed || s.readOnly) return;
      if (ops.length === 0) {
        s.dirty = false;
        sendState();
        // A host flush still needs a `saved` reply when there is nothing
        // to write, or the 30s timeout in document-editor-host fires.
        if (reason === "flush") s.bridge?.send("saved", { revision: s.revision });
        return;
      }
      const generation = s.dirtyGeneration;
      // Snapshot which edits this save covers — edits committed after this
      // point stay pending even though the save succeeds.
      const sentText = new Set(editsRef.current.textEdits.map((e) => e.id));
      const sentInserts = new Set(editsRef.current.textInserts.map((e) => e.id));
      const sentImages = new Set(editsRef.current.imageEdits.map((e) => e.id));
      s.saving = true;
      sendState();
      try {
        const res = await apiPost<{ revision: string }>("patch", {
          sessionId: s.init!.sessionId,
          baseRevision: s.revision,
          ops,
        });
        s.revision = res.revision;
        s.savedGeneration = Math.max(s.savedGeneration, generation);
        // Clear only the edits this save actually wrote.
        setTextEdits((prev) => prev.filter((e) => !sentText.has(e.id)));
        setTextInserts((prev) => prev.filter((e) => !sentInserts.has(e.id)));
        setImageEdits((prev) => prev.filter((e) => !sentImages.has(e.id)));
        if (s.dirtyGeneration === generation) {
          s.dirty = false;
          setConflict(null);
        }
        void fetch(`/api/documents/draft?path=${encodeURIComponent(s.init!.virtualPath)}`, {
          method: "DELETE",
        }).catch(() => {});
        s.bridge?.send("saved", { revision: res.revision });
        // Reload the rendered bytes at the committed revision so previews and
        // the canvas always show the real file.
        void loadDocument().catch(() => {});
      } catch (err) {
        const e = err as {
          code?: string;
          status?: number;
          currentRevision?: string;
          message?: string;
          details?: Record<string, unknown>;
        };
        if (e.code === "conflict" || e.status === 409) {
          setConflict({ currentRevision: e.currentRevision });
          s.bridge?.send("conflict", { currentRevision: e.currentRevision ?? "" });
        } else if (e.code === "invalid" || e.code === "verification-failed") {
          // Nothing was committed — keep every pending edit and surface the
          // per-op diagnostics the engine reported.
          setDiag({ message: e.message ?? "Edits could not be applied", details: e.details });
          sendState({ error: e.message });
        } else {
          sendState({ error: e.message ?? "Save failed" });
        }
        if (reason === "flush") throw err;
      } finally {
        s.saving = false;
        sendState();
        // A revision-changed notice that arrived mid-save: re-evaluate now
        // that s.revision reflects whatever this save committed.
        if (s.deferredRevision != null) {
          const rev = s.deferredRevision;
          s.deferredRevision = null;
          handleIncomingRevision(rev);
        }
      }
    },
    [handleIncomingRevision, loadDocument, pendingOps, sendState],
  );

  const pushDraft = useCallback(async () => {
    const s = st.current;
    const ops = pendingOps();
    if (!s.dirty || s.disposed || ops.length === 0) return;
    try {
      const qs = new URLSearchParams({
        path: s.init!.virtualPath,
        sessionId: s.init!.sessionId,
        baseRevision: s.revision,
      });
      await fetch(`/api/documents/draft?${qs}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: JSON.stringify({ ops }),
      });
    } catch {
      /* draft is best-effort */
    }
  }, [pendingOps]);

  const doSaveRef = useRef(doSave);
  const pushDraftRef = useRef(pushDraft);
  const markDirtyRef = useRef(markDirty);
  doSaveRef.current = doSave;
  pushDraftRef.current = pushDraft;
  markDirtyRef.current = markDirty;

  // ── edit interactions ───────────────────────────────────────────────────

  const pagePointToPdf = useCallback(
    (pageIndex: number, e: { clientX: number; clientY: number }, el: HTMLElement): [number, number] => {
      const box = el.getBoundingClientRect();
      const vx = (e.clientX - box.left) / scale;
      const vy = (e.clientY - box.top) / scale;
      const crop = pageCrop(pageIndex);
      const [x, y] = viewToPdf(pageGeom(pageIndex), vx, vy);
      return [x + crop[0], y + crop[1]];
    },
    [pageCrop, pageGeom, scale],
  );

  const blockAt = useCallback(
    (pageIndex: number, x: number, y: number): TextBlock | null =>
      (pageBlocks.get(pageIndex) ?? []).find(
        (b) => x >= b.rect[0] - 2 && x <= b.rect[2] + 2 && y >= b.rect[1] - 2 && y <= b.rect[3] + 2,
      ) ?? null,
    [pageBlocks],
  );

  const openBlockDraft = useCallback(
    (pageIndex: number, block: TextBlock, editId?: string, value?: string) => {
      const firstLine = block.lines[0]!;
      setDraft({
        pageIndex,
        rect: block.rect,
        oldText: joinBlockLines(block.lines.map((l) => l.text)),
        fontSize: block.fontSize,
        value: value ?? joinBlockLines(block.lines.map((l) => l.text)),
        editId,
        block: {
          leftPt: block.rect[0],
          firstBaseline: firstLine.y,
          widthPt: block.rect[2] - block.rect[0],
          lineHeight: block.lineHeight,
          align: block.align,
          bottomPt: block.rect[1],
        },
      });
    },
    [],
  );

  /** Fold a block draft into the pending edit list — mirrors upstream
      mergeTextDraft's paragraph path (reflow inside the block only). */
  const commitDraft = useCallback((domValue?: string) => {
    const d = draft;
    if (!d) return;
    const s = st.current;
    // Blur can fire before React flushes the last onChange — trust the DOM.
    const value = domValue ?? d.value;
    if (value.trim() === d.oldText.trim() || value === d.oldText) {
      setDraft(null);
      return;
    }
    if (value.trim() === "") {
      // Empty = delete the block's runs.
      setTextEdits((prev) => [
        ...prev.filter((e) => e.id !== d.editId),
        {
          id: d.editId ?? newId(),
          input: {
            pageIndex: d.pageIndex,
            rect: d.rect,
            oldText: d.oldText,
            newText: "",
            fontSize: d.fontSize,
          },
        },
      ]);
      setDraft(null);
      markDirty();
      return;
    }
    const css = getComputedStyle(document.body).fontFamily;
    const lineLeading = d.block.lineHeight;
    const wrapped = value
      .split("\n")
      .flatMap((p) => (p.trim() ? wrapText(p, d.block.widthPt, d.fontSize, css) : []));
    const overflowed = reflowOverflows(
      d.block,
      wrapped.length,
      lineLeading,
      d.fontSize,
      (pageBlocks.get(d.pageIndex) ?? []).map((b) => ({ rect: b.rect })),
      d.rect,
    );
    if (overflowed) {
      setDiag({ message: `${t("pdfEditor:overflow")} ${t("pdfEditor:convertHint")}` });
      return;
    }
    const lineXOffsets =
      d.block.align === "left"
        ? undefined
        : wrapped.map((l) => {
            const slack = d.block.widthPt - measurePt(l, d.fontSize, css);
            return Math.max(0, d.block.align === "center" ? slack / 2 : slack);
          });
    const input: PdfTextEdit = {
      pageIndex: d.pageIndex,
      rect: d.rect,
      oldText: d.oldText,
      newText: wrapped.join("\n"),
      fontSize: d.fontSize,
      origin: [d.block.leftPt, d.block.firstBaseline],
      lineLeading,
      lineXOffsets,
      align: d.block.align !== "left" ? d.block.align : undefined,
      blockSource: value,
    };
    setTextEdits((prev) => {
      const next = prev.filter((e) => e.id !== d.editId);
      return [...next, { id: d.editId ?? newId(), input }];
    });
    setDraft(null);
    markDirty();
    void s;
  }, [draft, markDirty, pageBlocks, t]);

  const commitInsert = useCallback((domValue?: string) => {
    const d = insertDraft;
    if (!d) return;
    const value = domValue ?? d.value;
    const text = value.trim();
    setInsertDraft(null);
    if (!text) return;
    const input: PdfTextInsert = {
      pageIndex: d.pageIndex,
      origin: d.origin,
      text: value.replace(/\s+$/, ""),
      fontSize: 14,
      color: [0, 0, 0],
      lineLeading: 14 * 1.2,
      rotate: d.rotate,
    };
    setTextInserts((prev) => [...prev, { id: newId(), input }]);
    markDirty();
  }, [insertDraft, markDirty]);

  const onPageMouseMove = useCallback(
    (pageIndex: number, e: React.MouseEvent<HTMLElement>) => {
      if (tool !== "editText" || draft || st.current.readOnly) return;
      const [x, y] = pagePointToPdf(pageIndex, e, e.currentTarget);
      const block = blockAt(pageIndex, x, y);
      if (!block) {
        setHoverBlock(null);
        return;
      }
      const gate = blockEditable(pageIndex, block);
      setHoverBlock({ pageIndex, block, editable: gate.editable, reason: gate.reason });
    },
    [blockAt, blockEditable, draft, pagePointToPdf, tool],
  );

  const onPageClick = useCallback(
    (pageIndex: number, e: React.MouseEvent<HTMLElement>) => {
      if (st.current.readOnly) return;
      // A click inside an open draft bubbles up — don't re-open the block.
      if (draft || insertDraft) return;
      const [x, y] = pagePointToPdf(pageIndex, e, e.currentTarget);
      if (tool === "insertText") {
        setInsertDraft({
          pageIndex,
          origin: [x, y],
          rotate: ((pageGeom(pageIndex).rot % 360) + 360) % 360,
          value: "",
        });
        return;
      }
      if (tool === "image" && pendingImage) {
        // Default size: image pixels at 72dpi (1pt per px), top-left at click,
        // clamped into the page bounds.
        const geom = pageGeom(pageIndex);
        const crop = pageCrop(pageIndex);
        const pw = crop[2] - crop[0] || geom.pw;
        const ph = crop[3] - crop[1] || geom.ph;
        const wPt = Math.min(pendingImage.widthPx, pw);
        const hPt = Math.min(pendingImage.heightPx, ph);
        const x1 = Math.min(Math.max(x, crop[0]), crop[2] - wPt);
        const yTop = Math.min(Math.max(y, crop[1] + hPt), crop[3]);
        const input: PdfImageEdit = {
          kind: "insertImage",
          pageIndex,
          image: pendingImage.png,
          rect: [x1, yTop - hPt, x1 + wPt, yTop],
          layer: "aboveText",
          rotate: ((geom.rot % 360) + 360) % 360,
        };
        setImageEdits((prev) => [...prev, { id: newId(), input: input as LocalImageEdit["input"] }]);
        setPendingImage(null);
        markDirty();
        return;
      }
      if (tool === "editText") {
        const block = blockAt(pageIndex, x, y);
        if (!block) return;
        const gate = blockEditable(pageIndex, block);
        if (!gate.editable) {
          setDiag({ message: gate.reason ?? t("pdfEditor:nonEditable") });
          return;
        }
        // Re-open the pending edit covering this block when one exists.
        const existing = textEdits.find(
          (te) =>
            te.input.pageIndex === pageIndex &&
            te.input.rect.every((v, i) => Math.abs(v - block.rect[i]!) < 2),
        );
        openBlockDraft(
          pageIndex,
          block,
          existing?.id,
          existing ? (existing.input.blockSource ?? existing.input.newText.split("\n").join(" ")) : undefined,
        );
      }
    },
    [blockAt, blockEditable, draft, insertDraft, markDirty, openBlockDraft, pageCrop, pageGeom, pagePointToPdf, pendingImage, t, textEdits, tool],
  );

  // ── image ops ───────────────────────────────────────────────────────────

  const readImageFile = useCallback((file: File): Promise<PendingImage | null> => {
    if (file.size > IMAGE_FILE_CAP) return Promise.resolve(null);
    if (file.type !== "image/png" && file.type !== "image/jpeg") return Promise.resolve(null);
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext("2d")!.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        const png = canvas.toDataURL("image/png").split(",")[1] ?? null;
        resolve(png ? { png, widthPx: img.naturalWidth, heightPx: img.naturalHeight } : null);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    });
  }, []);

  const onExistingRect = useCallback(
    (ref: PageImageRef, rect: Rect4) => {
      setImageEdits((prev) => {
        const rest = prev.filter(
          (e) => !(e.input.pageIndex === ref.pageIndex && rectKey(oldRectOf(e.input) ?? []) === rectKey(ref.rect)),
        );
        return [
          ...rest,
          {
            id: newId(),
            input: {
              kind: "transformImage",
              pageIndex: ref.pageIndex,
              oldRect: ref.rect,
              rect,
            },
          },
        ];
      });
      setSelImage({ pageIndex: ref.pageIndex, rect });
      markDirty();
    },
    [markDirty],
  );

  const onPendingImageRect = useCallback(
    (id: string, rect: Rect4) => {
      setImageEdits((prev) =>
        prev.map((e) =>
          e.id === id && "rect" in e.input ? { ...e, input: { ...e.input, rect } } : e,
        ),
      );
      markDirty();
    },
    [markDirty],
  );

  const deleteImage = useCallback(() => {
    const sel = selImage;
    if (!sel) return;
    const pending = imageEdits.find(
      (e) =>
        e.input.pageIndex === sel.pageIndex &&
        rectKey(oldRectOf(e.input) ?? []) === rectKey(sel.rect),
    );
    if (pending && pending.input.kind === "transformImage") {
      // Fold move/resize into the delete — only the delete reaches the file.
      setImageEdits((prev) => [
        ...prev.filter((e) => e.id !== pending.id),
        {
          id: newId(),
          input: { kind: "deleteImage", pageIndex: sel.pageIndex, oldRect: oldRectOf(pending.input)! },
        },
      ]);
    } else {
      setImageEdits((prev) => [
        ...prev,
        { id: newId(), input: { kind: "deleteImage", pageIndex: sel.pageIndex, oldRect: sel.rect } },
      ]);
    }
    setSelImage(null);
    markDirty();
  }, [imageEdits, markDirty, selImage]);

  const onReplacePicked = useCallback(
    async (file: File | undefined) => {
      const sel = selImage;
      if (!file || !sel) return;
      const img = await readImageFile(file);
      if (!img) {
        setDiag({ message: t("pdfEditor:imageInvalid") });
        return;
      }
      const oldRect =
        oldRectOf(
          imageEdits.find(
            (e) =>
              e.input.pageIndex === sel.pageIndex &&
              rectKey(oldRectOf(e.input) ?? []) === rectKey(sel.rect),
          )?.input ?? { kind: "deleteImage", pageIndex: 0, oldRect: sel.rect },
        ) ?? sel.rect;
      setImageEdits((prev) => [
        ...prev.filter(
          (e) =>
            !(e.input.pageIndex === sel.pageIndex && rectKey(oldRectOf(e.input) ?? []) === rectKey(oldRect)),
        ),
        {
          id: newId(),
          input: {
            kind: "replaceImage",
            pageIndex: sel.pageIndex,
            oldRect,
            rect: sel.rect,
            image: img.png,
          },
        },
      ]);
      setSelImage(null);
      markDirty();
    },
    [imageEdits, markDirty, readImageFile, selImage, t],
  );

  // ── bridge ──────────────────────────────────────────────────────────────

  const onBridgeMessage = useCallback(
    (msg: BridgeMessage) => {
      const s = st.current;
      switch (msg.type) {
        case "init": {
          if (s.init) break;
          s.init = msg as unknown as InitMsg;
          s.revision = s.init.revision;
          s.readOnly = Boolean(s.init.readOnlyReason);
          document.documentElement.dataset.theme = s.init.theme;
          void loadDocument()
            .then(() => {
              setStatus("ready");
              s.bridge?.send("ready", { virtualPath: s.init!.virtualPath });
              sendState();
            })
            .catch((e: Error) => {
              setStatus("error");
              setErrorText(e.message);
            });
          break;
        }
        case "save-request":
          void doSaveRef.current("flush").catch((e: Error) => sendState({ error: e.message }));
          break;
        case "revision-changed": {
          const incoming = String(msg.revision ?? "");
          if (s.saving) {
            // Defer until the save settles — the daemon echoes our own
            // commits and the comparison needs the post-save revision.
            s.deferredRevision = incoming;
            break;
          }
          handleIncomingRevision(incoming);
          break;
        }
        case "theme":
          document.documentElement.dataset.theme = String(msg.theme ?? "light");
          break;
        case "dispose":
          s.disposed = true;
          break;
      }
    },
    [handleIncomingRevision, loadDocument, sendState],
  );

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const channel = hash.get("channel") ?? "";
    if (!channel) {
      setStatus("error");
      setErrorText("Missing bridge channel");
      return;
    }
    const bridge = createFrameBridge(channel, onBridgeMessage);
    st.current.bridge = bridge;
    bridge.send("request", { action: "init" });

    // Test/debug hook: lets E2E inject a pending op the engine cannot match
    // (equivalent to a stale edit against changed bytes). Only exposed under
    // browser automation (Playwright sets navigator.webdriver) — never in a
    // normal user session. NEXT_PUBLIC_* cannot gate this because the value
    // is inlined at build time and E2E runs the production bundle.
    if (navigator.webdriver) {
      (window as unknown as { __cabinetPdf?: unknown }).__cabinetPdf = {
        injectEdit: (input: PdfTextEdit) => {
          setTextEdits((prev) => [...prev, { id: newId(), input }]);
          markDirtyRef.current();
        },
      };
    }

    const keyHandler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void doSaveRef.current("manual");
      }
    };
    const unloadHandler = (e: BeforeUnloadEvent) => {
      if (st.current.dirty || st.current.saving) e.preventDefault();
    };
    window.addEventListener("keydown", keyHandler);
    window.addEventListener("beforeunload", unloadHandler);
    return () => {
      bridge.dispose();
      window.removeEventListener("keydown", keyHandler);
      window.removeEventListener("beforeunload", unloadHandler);
    };
  }, [onBridgeMessage]);

  // Dirty mirrors the pending-edit state: removing the last pending edit (e.g.
  // by clicking its preview away) leaves nothing to save.
  useEffect(() => {
    if (!dirtyEdits) st.current.dirty = false;
  }, [dirtyEdits]);

  // ── render ──────────────────────────────────────────────────────────────

  const ro = st.current.readOnly;
  const zoom = (dir: 1 | -1) =>
    setScale((v) => Math.min(4, Math.max(0.25, Math.round(v * (dir > 0 ? 1.2 : 1 / 1.2) * 100) / 100)));

  return (
    <div className="doc-editor-frame pdf-app">
      {conflict && (
        <div className="doc-conflict-banner" role="alert">
          <span>{t("docxEditor:conflictBanner")}</span>
          <span className="doc-conflict-actions">
            <button
              type="button"
              onClick={() => {
                if (window.confirm(t("docxEditor:confirmReload"))) {
                  const s = st.current;
                  s.dirty = false;
                  s.dirtyGeneration++;
                  resetEdits();
                  setConflict(null);
                  void loadDocument().then(() =>
                    apiPost<{ revision: string }>("revision", {
                      virtualPath: s.init!.virtualPath,
                    }).then((r) => {
                      s.revision = r.revision;
                    }),
                  );
                }
              }}
            >
              {t("docxEditor:reloadLatest")}
            </button>
            <button type="button" onClick={() => st.current.bridge?.send("request", { action: "save-copy" })}>
              {t("docxEditor:saveACopy")}
            </button>
          </span>
        </div>
      )}
      <div className="pdf-frame-toolbar">
        <div className="pdf-frame-tools">
          <button
            type="button"
            className={tool === "select" ? "active" : ""}
            onClick={() => setTool("select")}
            disabled={ro}
          >
            {t("pdfEditor:toolSelect")}
          </button>
          <button
            type="button"
            className={tool === "editText" ? "active" : ""}
            onClick={() => setTool("editText")}
            disabled={ro}
          >
            {t("pdfEditor:toolEditText")}
          </button>
          <button
            type="button"
            className={tool === "insertText" ? "active" : ""}
            onClick={() => setTool("insertText")}
            disabled={ro}
          >
            {t("pdfEditor:toolInsertText")}
          </button>
          <button
            type="button"
            className={tool === "image" ? "active" : ""}
            onClick={() => setTool("image")}
            disabled={ro}
          >
            {t("pdfEditor:toolImages")}
          </button>
          <button
            type="button"
            onClick={() => {
              setTool("image");
              imageFileRef.current?.click();
            }}
            disabled={ro}
          >
            {t("pdfEditor:insertImage")}
          </button>
        </div>
        <div className="pdf-frame-zoom">
          <button type="button" onClick={() => zoom(-1)} aria-label="zoom out">
            −
          </button>
          <span>{Math.round(scale * 100)}%</span>
          <button type="button" onClick={() => zoom(1)} aria-label="zoom in">
            +
          </button>
          <button
            type="button"
            className="pdf-frame-save"
            onClick={() => void doSaveRef.current("manual")}
            disabled={ro || st.current.saving}
          >
            {t("pdfEditor:save")}
          </button>
        </div>
      </div>
      {geometry?.signed && !signedDismissed && dirtyEdits && (
        <div className="doc-conflict-banner pdf-sign-banner" role="alert" style={{ position: "static" }}>
          <span>{t("pdfEditor:signedWarning")}</span>
          <span className="doc-conflict-actions">
            <button type="button" onClick={() => setSignedDismissed(true)}>
              ×
            </button>
          </span>
        </div>
      )}
      {diag && (
        <div className="doc-conflict-banner pdf-diag-banner" role="alert" style={{ position: "static" }}>
          <span>{diag.message}</span>
          <span className="doc-conflict-actions">
            <button type="button" onClick={() => setDiag(null)}>
              ×
            </button>
          </span>
        </div>
      )}
      {status === "loading" && <div className="doc-editor-frame-status">{t("docxEditor:loading")}</div>}
      {status === "error" && (
        <div className="doc-editor-frame-status">{errorText ?? t("docxEditor:loadFailed")}</div>
      )}
      <div ref={scrollRef} className="doc-editor-scroll pdf-scroll">
        {doc &&
          geometry &&
          geometry.pages.map((page: PdfPageGeometry) => {
            const geom = pageGeom(page.index);
            const disp = geomDispSize(geom);
            const crop = page.cropBox;
            const pageEdits = textEdits.filter((te) => te.input.pageIndex === page.index);
            const pageInserts = textInserts.filter((ti) => ti.input.pageIndex === page.index);
            const pageImageEdits = imageEdits.filter((ie) => ie.input.pageIndex === page.index);
            const claimedRects = new Set(
              pageImageEdits.map((e) => ("oldRect" in e.input ? e.input.oldRect.map((v) => v.toFixed(2)).join(",") : "")),
            );
            const existing = (pageImages.get(page.index) ?? []).filter(
              (r) => !claimedRects.has(r.rect.map((v) => v.toFixed(2)).join(",")),
            );
            return (
              <div
                key={page.index}
                className="pdf-page"
                style={
                  {
                    width: Math.floor(disp.width * scale),
                    height: Math.floor(disp.height * scale),
                    "--scale-factor": scale,
                  } as React.CSSProperties
                }
                onClick={(e) => onPageClick(page.index, e)}
                onMouseMove={(e) => onPageMouseMove(page.index, e)}
                onMouseLeave={() => setHoverBlock((h) => (h?.pageIndex === page.index ? null : h))}
              >
                <div className="pdf-page-content">
                  <PdfPage
                    doc={doc}
                    pageNo={page.index + 1}
                    scale={scale}
                    rotationDelta={0}
                    visible
                    onRenderState={() => {}}
                  />
                </div>
                {/* pending text-edit covers + previews */}
                {pageEdits.map((te) => {
                  const { style, coverStyle } = textEditPreviewParts(
                    { ...te, input: { ...te.input, rect: cropRect(te.input.rect, crop) } },
                    geom,
                    scale,
                  );
                  const cover = te.cover
                    ? inflateCss(pdfRectToCss(geom, cropRect(unionCover(te.input.rect, te.cover), crop), scale), 1.5)
                    : coverStyle;
                  return (
                    <div key={te.id}>
                      {cover && <div className="pdf-textedit-cover" style={cover} />}
                      <div
                        className="pdf-textedit-preview"
                        style={style}
                        title={t("pdfEditor:pendingEdit")}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (tool !== "editText") return;
                          const block = (pageBlocks.get(page.index) ?? []).find(
                            (b) => b.rect.every((v, i) => Math.abs(v - te.input.rect[i]!) < 2),
                          );
                          if (block) {
                            openBlockDraft(
                              page.index,
                              block,
                              te.id,
                              te.input.blockSource ?? te.input.newText.split("\n").join(" "),
                            );
                          } else {
                            setTextEdits((prev) => prev.filter((x) => x.id !== te.id));
                          }
                        }}
                      >
                        {textEditPreviewContent({ ...te, input: { ...te.input, rect: cropRect(te.input.rect, crop) } }, scale)}
                      </div>
                    </div>
                  );
                })}
                {pageInserts.map((ti) => (
                  <div
                    key={ti.id}
                    className="pdf-textinsert-preview"
                    style={textInsertPreviewStyle(
                      {
                        ...ti,
                        input: {
                          ...ti.input,
                          origin: [ti.input.origin[0] - crop[0], ti.input.origin[1] - crop[1]],
                        },
                      },
                      geom,
                      scale,
                    )}
                    title={t("pdfEditor:pendingEdit")}
                    onClick={(e) => {
                      e.stopPropagation();
                      setTextInserts((prev) => prev.filter((x) => x.id !== ti.id));
                    }}
                  >
                    {ti.input.text}
                  </div>
                ))}
                {/* hover affordance for the block under the cursor */}
                {tool === "editText" && hoverBlock && hoverBlock.pageIndex === page.index && (
                  <div
                    className={`pdf-textline-hover${hoverBlock.editable ? "" : " pdf-textline-locked"}`}
                    style={pdfRectToCss(geom, cropRect(hoverBlock.block.rect, crop), scale)}
                    title={hoverBlock.editable ? undefined : hoverBlock.reason}
                  />
                )}
                {/* block draft editor */}
                {draft && draft.pageIndex === page.index && (
                  <div
                    className="pdf-textedit-editor"
                    style={pdfRectToCss(geom, cropRect(draft.rect, crop), scale)}
                  >
                    <textarea
                      className="pdf-textedit-input pdf-textedit-block"
                      autoFocus
                      value={draft.value}
                      style={{
                        width: "100%",
                        minHeight: "100%",
                        fontSize: draft.fontSize * scale * 0.92,
                        lineHeight: `${draft.block.lineHeight * scale}px`,
                      }}
                      onChange={(e) => setDraft({ ...draft, value: e.target.value })}
                      onBlur={(e) => commitDraft(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setDraft(null);
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commitDraft();
                      }}
                    />
                  </div>
                )}
                {/* insert-text draft editor */}
                {insertDraft && insertDraft.pageIndex === page.index && (() => {
                  const [vx, vy] = pdfToView(geom, insertDraft.origin[0] - crop[0], insertDraft.origin[1] - crop[1]);
                  return (
                    <textarea
                      className="pdf-textedit-input pdf-insert-draft"
                      autoFocus
                      value={insertDraft.value}
                      placeholder={t("pdfEditor:typeHere")}
                      style={{
                        left: vx * scale,
                        top: (vy - 14) * scale,
                        fontSize: 14 * scale * 0.92,
                      }}
                      onChange={(e) => setInsertDraft({ ...insertDraft, value: e.target.value })}
                      onBlur={(e) => commitInsert(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setInsertDraft(null);
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commitInsert();
                      }}
                    />
                  );
                })()}
                {/* image edit layer (select/move/resize handles) */}
                <ImageEditLayer
                  geom={geom}
                  scale={scale}
                  edits={pageImageEdits.map((e) => ({
                    ...e,
                    input:
                      "rect" in e.input
                        ? { ...e.input, rect: cropRect(e.input.rect as Rect4, crop) }
                        : "oldRect" in e.input
                          ? { ...e.input, oldRect: cropRect(e.input.oldRect as Rect4, crop) }
                          : e.input,
                  }))}
                  existing={existing.map((r) => ({ ...r, rect: cropRect(r.rect, crop) }))}
                  selectedId={null}
                  selectedKey={
                    selImage && selImage.pageIndex === page.index
                      ? selImage.rect.map((v) => v.toFixed(2)).join(",")
                      : null
                  }
                  editHint=""
                  onSelectEdit={() => setSelImage(null)}
                  onSelectExisting={(ref) =>
                    setSelImage({
                      pageIndex: page.index,
                      rect: [ref.rect[0] + crop[0], ref.rect[1] + crop[1], ref.rect[2] + crop[0], ref.rect[3] + crop[1]],
                    })
                  }
                  onRect={
                    ro
                      ? undefined
                      : (id, rect) =>
                          onPendingImageRect(id, [
                            rect[0] + crop[0],
                            rect[1] + crop[1],
                            rect[2] + crop[0],
                            rect[3] + crop[1],
                          ])
                  }
                  onExistingRect={
                    ro || tool !== "image"
                      ? undefined
                      : (ref, rect) =>
                          onExistingRect(
                            { ...ref, rect: [ref.rect[0] + crop[0], ref.rect[1] + crop[1], ref.rect[2] + crop[0], ref.rect[3] + crop[1]] },
                            [rect[0] + crop[0], rect[1] + crop[1], rect[2] + crop[0], rect[3] + crop[1]],
                          )
                  }
                />
                {/* floating menu for a selected existing image */}
                {tool === "image" && selImage && selImage.pageIndex === page.index && (
                  <div
                    className="pdf-imgmenu"
                    style={{
                      left: pdfRectToCss(geom, cropRect(selImage.rect, crop), scale).left,
                      top: Math.max(0, pdfRectToCss(geom, cropRect(selImage.rect, crop), scale).top - 34),
                    }}
                  >
                    <button type="button" onClick={(e) => { e.stopPropagation(); deleteImage(); }}>
                      {t("pdfEditor:deleteImage")}
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        replaceFileRef.current?.click();
                      }}
                    >
                      {t("pdfEditor:replaceImage")}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
      </div>
      <input
        ref={imageFileRef}
        type="file"
        accept="image/png,image/jpeg"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          const img = await readImageFile(file);
          if (!img) setDiag({ message: t("pdfEditor:imageInvalid") });
          else setPendingImage(img);
        }}
      />
      <input
        ref={replaceFileRef}
        type="file"
        accept="image/png,image/jpeg"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          await onReplacePicked(file);
        }}
      />
    </div>
  );
}
