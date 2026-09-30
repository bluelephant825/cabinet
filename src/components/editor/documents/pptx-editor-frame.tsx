"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { createFrameBridge, type BridgeMessage } from "@/lib/documents/frame-bridge";
import type { PptxDocumentModel, PptxSavePlan } from "@/lib/documents/types";

interface InitMessage {
  sessionId: string;
  revision: string;
  virtualPath: string;
  theme: "light" | "dark";
}

type Previewer = { preview(buffer: ArrayBuffer): Promise<unknown>; destroy?: () => void };

async function apiPost<T>(op: string, body: unknown): Promise<T> {
  const response = await fetch(`/api/documents/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(json.error ?? `Request failed (${response.status})`) as Error & {
      code?: string;
      currentRevision?: string;
    };
    error.code = json.code;
    error.currentRevision = json.currentRevision ?? json.details?.currentRevision;
    throw error;
  }
  return json as T;
}

function savePlan(original: PptxDocumentModel, current: PptxDocumentModel): PptxSavePlan {
  const textEdits: PptxSavePlan["textEdits"] = [];
  const notesEdits: PptxSavePlan["notesEdits"] = [];
  current.slides.forEach((slide, slideIndex) => {
    const before = original.slides[slideIndex];
    if (!before) return;
    if (slide.notes !== before.notes) notesEdits.push({ slideIndex, text: slide.notes });
    slide.elements.forEach((element) => {
      const prior = before.elements.find((candidate) => candidate.id === element.id);
      if (prior && JSON.stringify(element.paragraphs) !== JSON.stringify(prior.paragraphs)) {
        textEdits.push({ slideIndex, elementId: element.id, paragraphs: element.paragraphs });
      }
    });
  });
  return { textEdits, notesEdits };
}

export default function PptxEditorFrame() {
  const previewRef = useRef<HTMLDivElement | null>(null);
  const previewerRef = useRef<Previewer | null>(null);
  const bridgeRef = useRef<ReturnType<typeof createFrameBridge> | null>(null);
  const initRef = useRef<InitMessage | null>(null);
  const originalRef = useRef<PptxDocumentModel | null>(null);
  const modelRef = useRef<PptxDocumentModel | null>(null);
  const revisionRef = useRef("");
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadKeyRef = useRef("");
  const saveRef = useRef<(flush?: boolean) => Promise<void>>(async () => {});
  const [model, setModel] = useState<PptxDocumentModel | null>(null);
  const [activeSlide, setActiveSlide] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const sendState = useCallback((message?: string) => {
    bridgeRef.current?.send("state", {
      dirty: dirtyRef.current,
      saving: savingRef.current,
      ...(message ? { error: message } : {}),
    });
  }, []);

  const renderPreview = useCallback(async (virtualPath: string, revision: string) => {
    const container = previewRef.current;
    if (!container) return;
    previewerRef.current?.destroy?.();
    container.innerHTML = "";
    const [{ init }, response] = await Promise.all([
      import("pptx-preview"),
      fetch(`/api/assets/${virtualPath}?revision=${encodeURIComponent(revision)}`),
    ]);
    if (!response.ok) throw new Error(`Failed to load presentation (${response.status})`);
    const width = Math.max(720, container.clientWidth - 32);
    const previewer = init(container, { width, height: Math.round((width * 9) / 16), mode: "list" }) as Previewer;
    previewerRef.current = previewer;
    await previewer.preview(await response.arrayBuffer());
  }, []);

  const load = useCallback(async () => {
    const init = initRef.current;
    if (!init) return;
    const key = `${init.sessionId}:${revisionRef.current}`;
    if (loadKeyRef.current === key) return;
    loadKeyRef.current = key;
    setError(null);
    try {
      performance.mark("cabinet-pptx-init-start");
      const next = await apiPost<PptxDocumentModel>("pptx/load", { sessionId: init.sessionId });
      await renderPreview(init.virtualPath, revisionRef.current);
      originalRef.current = structuredClone(next);
      modelRef.current = next;
      setModel(next);
      setActiveSlide((index) => Math.min(index, Math.max(0, next.slides.length - 1)));
      requestAnimationFrame(() => {
        performance.mark("cabinet-pptx-ready");
        performance.measure("cabinet-pptx-init", "cabinet-pptx-init-start", "cabinet-pptx-ready");
        document.documentElement.dataset.pptxReady = "true";
        bridgeRef.current?.send("ready");
      });
    } catch (cause) {
      loadKeyRef.current = "";
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      sendState(message);
    }
  }, [renderPreview, sendState]);

  const save = useCallback(async (flush = false) => {
    const init = initRef.current;
    const original = originalRef.current;
    const current = modelRef.current;
    if (!init || !original || !current || savingRef.current) return;
    if (!dirtyRef.current) {
      if (flush) bridgeRef.current?.send("saved", { revision: revisionRef.current });
      return;
    }
    savingRef.current = true;
    sendState();
    let resave = false;
    try {
      const result = await apiPost<{ revision: string }>("pptx/save", {
        sessionId: init.sessionId,
        baseRevision: revisionRef.current,
        plan: savePlan(original, current),
      });
      revisionRef.current = result.revision;
      originalRef.current = structuredClone(current);
      if (modelRef.current === current) {
        dirtyRef.current = false;
        bridgeRef.current?.send("saved", { revision: result.revision });
      } else {
        dirtyRef.current = true;
        resave = true;
      }
      await renderPreview(init.virtualPath, result.revision);
    } catch (cause) {
      const failure = cause as Error & { code?: string; currentRevision?: string };
      if (failure.code === "conflict") {
        bridgeRef.current?.send("conflict", { currentRevision: failure.currentRevision });
      } else {
        setError(failure.message);
        sendState(failure.message);
      }
    } finally {
      savingRef.current = false;
      sendState();
      if (resave) {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => void saveRef.current(flush), 0);
      }
    }
  }, [renderPreview, sendState]);
  saveRef.current = save;

  const markDirty = useCallback((next: PptxDocumentModel) => {
    modelRef.current = next;
    setModel(next);
    dirtyRef.current = true;
    sendState();
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void saveRef.current(), 2000);
  }, [sendState]);

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    bridgeRef.current = createFrameBridge(hash.get("channel") ?? "", (message: BridgeMessage) => {
      if (message.type === "init") {
        initRef.current = message as unknown as InitMessage;
        revisionRef.current = String(message.revision ?? "");
        void load();
      } else if (message.type === "save-request") {
        void saveRef.current(true);
      } else if (message.type === "revision-changed") {
        if (dirtyRef.current) bridgeRef.current?.send("conflict", { currentRevision: message.revision });
        else {
          revisionRef.current = String(message.revision ?? "");
          loadKeyRef.current = "";
          void load();
        }
      }
    });
    bridgeRef.current.send("request", { action: "init" });
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      previewerRef.current?.destroy?.();
      bridgeRef.current?.dispose();
    };
  }, [load]);

  const slide = model?.slides[activeSlide];
  return (
    <main className="h-screen min-h-0 bg-(--surface) text-(--text) flex">
      <aside className="w-72 shrink-0 border-r border-(--border) flex flex-col bg-(--surface-raised)">
        <div className="px-3 py-2 border-b border-(--border) text-sm font-medium">Slides</div>
        <div className="flex-1 overflow-auto p-2 space-y-1">
          {model?.slides.map((item) => (
            <button
              type="button"
              key={item.index}
              onClick={() => setActiveSlide(item.index)}
              className={`w-full text-left rounded px-3 py-2 text-sm ${item.index === activeSlide ? "bg-(--accent-soft)" : "hover:bg-(--hover)"}`}
            >
              Slide {item.index + 1}
            </button>
          ))}
        </div>
      </aside>
      <section className="flex-1 min-w-0 overflow-auto bg-(--canvas) p-4">
        {error ? <div className="mb-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm">{error}</div> : null}
        <div ref={previewRef} className="mx-auto max-w-6xl" data-pptx-preview />
      </section>
      <aside className="w-80 shrink-0 border-l border-(--border) bg-(--surface-raised) flex flex-col">
        <div className="px-3 py-2 border-b border-(--border) text-sm font-medium">
          Slide {activeSlide + 1} text and notes
        </div>
        <div className="flex-1 overflow-auto p-3 space-y-4">
          {slide?.elements.map((element, elementIndex) => (
            <section key={element.id} className="rounded border border-(--border) p-2 space-y-2">
              <div className="text-xs font-medium text-(--text-muted)">{element.name || `Text ${elementIndex + 1}`}</div>
              {element.paragraphs.map((paragraph, paragraphIndex) =>
                paragraph.runs.map((run, runIndex) => (
                  <textarea
                    key={`${paragraphIndex}:${runIndex}`}
                    value={run.text}
                    aria-label={`Slide ${activeSlide + 1} ${element.name || `text ${elementIndex + 1}`} run ${runIndex + 1}`}
                    onChange={(event) => {
                      if (!model) return;
                      const next = structuredClone(model);
                      next.slides[activeSlide]!.elements[elementIndex]!.paragraphs[paragraphIndex]!.runs[runIndex]!.text = event.target.value;
                      markDirty(next);
                    }}
                    className="w-full min-h-16 resize-y rounded border border-(--border) bg-(--surface) px-2 py-1.5 text-sm"
                  />
                )),
              )}
            </section>
          ))}
          {slide ? (
            <label className="block space-y-2">
              <span className="text-xs font-medium text-(--text-muted)">Speaker notes</span>
              <textarea
                value={slide.notes}
                aria-label={`Slide ${activeSlide + 1} speaker notes`}
                onChange={(event) => {
                  if (!model) return;
                  const next = structuredClone(model);
                  next.slides[activeSlide]!.notes = event.target.value;
                  markDirty(next);
                }}
                className="w-full min-h-32 resize-y rounded border border-(--border) bg-(--surface) px-2 py-1.5 text-sm"
              />
            </label>
          ) : null}
        </div>
      </aside>
    </main>
  );
}
