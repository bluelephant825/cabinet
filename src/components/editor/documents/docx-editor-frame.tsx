"use client";

/**
 * The DOCX editor frame. Runs inside `/document-editor` — a same-origin iframe
 * the host viewer embeds. Talks to the host over `frame-bridge` postMessage and
 * to the server over `/api/documents/*` only (no daemon token, no abs paths).
 *
 * The editor uses the vendored GenOffice schema (blocksToPmDoc /
 * pmDocToSavePlan), NOT Cabinet's markdown Tiptap schema — document bytes are
 * patched, never round-tripped through markdown.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { Editor } from "@tiptap/core";

import { createFrameBridge, type BridgeMessage } from "@/lib/documents/frame-bridge";
import type { DocxDocumentModel, DocxSavePlan } from "@/lib/documents/types";
import { editorExtensions } from "../../../vendor/genoffice/apps/docs/src/renderer/editor/extensions";
import {
  blocksToPmDoc,
  pmDocToSavePlan,
  type PmNode,
} from "../../../vendor/genoffice/apps/docs/src/renderer/editor/convert";
import { setModuleLang } from "../../../vendor/genoffice/apps/docs/src/renderer/i18n/locale";
import { strings as editorStrings } from "../../../vendor/genoffice/apps/docs/src/renderer/i18n/strings";
import { setDocFontTable } from "../../../vendor/genoffice/apps/docs/src/renderer/line-metrics";
import { DocxToolbar } from "./docx-toolbar";
import {
  makePendingNumberingDef,
  nextNumId,
  readFormatState,
  type DocxFormatState,
  type ListKind,
} from "./docx-toolbar-commands";
import { useLocale } from "@/i18n/use-locale";
import "../../../vendor/genoffice/apps/docs/src/renderer/styles.css";
import "../../../app/document-editor/document-editor.css";

// ── copied from upstream App.tsx (not vendored): Word/web paste cleanup ────
function cleanPastedHtml(html: string): string {
  return html
    .replace(/<!--\[if[\s\S]*?<!\[endif\]-->/g, "")
    .replace(/<o:p>[\s\S]*?<\/o:p>/g, "")
    .replace(/<li([^>]*)>\s*<p[^>]*>([\s\S]*?)<\/p>\s*<\/li>/g, "<li$1>$2</li>");
}

type EditorLang = Parameters<typeof setModuleLang>[0];

/** navigator.language → nearest upstream Lang ('en-US' → 'en', else 'en'). */
function nearestEditorLang(locale: string | undefined): EditorLang {
  const langs = editorStrings as Record<string, unknown>;
  const full = locale ?? "";
  const base = full.split("-")[0];
  if (full && full in langs) return full as EditorLang;
  if (base in langs) return base as EditorLang;
  return "en" as EditorLang;
}

interface InitMsg {
  virtualPath: string;
  sessionId: string;
  revision: string;
  readOnlyReason?: string;
  theme: "light" | "dark";
  locale: string;
}

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
    };
    err.code = json.code;
    err.status = res.status;
    err.currentRevision = json.currentRevision;
    throw err;
  }
  return json as T;
}

export default function DocxEditorFrame() {
  const { t } = useLocale();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ currentRevision?: string } | null>(null);
  const [editorInstance, setEditorInstance] = useState<Editor | null>(null);
  const [formatState, setFormatState] = useState<DocxFormatState | null>(null);
  const [uiState, setUiState] = useState({ dirty: false, saving: false, readOnly: false });

  // Mutable editor state, kept in a ref so bridge handlers never go stale.
  const st = useRef({
    editor: null as Editor | null,
    bridge: null as ReturnType<typeof createFrameBridge> | null,
    init: null as InitMsg | null,
    blocks: [] as unknown[],
    revision: "",
    dirty: false,
    dirtyGeneration: 0,
    savedGeneration: 0,
    saving: false,
    readOnly: false,
    autosaveTimer: null as ReturnType<typeof setTimeout> | null,
    draftTimer: null as ReturnType<typeof setTimeout> | null,
    disposed: false,
    /** numId keys of the last loaded model (numbering.xml). */
    numberingKeys: [] as string[],
    /** Brand-new list definitions not yet written to numbering.xml. */
    pendingNumbering: { newDefs: [] as { numId: string; kind: ListKind }[] },
    numIdFloor: 0,
    /** A revision-changed notice received while a save was in flight. */
    deferredRevision: null as string | null,
  });

  const sendState = useCallback((extra?: Record<string, unknown>) => {
    const s = st.current;
    s.bridge?.send("state", {
      dirty: s.dirty,
      saving: s.saving,
      ...extra,
    });
    setUiState({ dirty: s.dirty, saving: s.saving, readOnly: s.readOnly });
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

  const loadModel = useCallback(async () => {
    const s = st.current;
    const init = s.init;
    if (!init) return;
    const model = await apiPost<DocxDocumentModel>("docx/load", {
      sessionId: init.sessionId,
    });
    s.blocks = model.blocks;
    // A reload re-parses numbering.xml — pending definitions are either saved
    // (and now part of the model) or discarded with the doc state.
    s.numberingKeys = model.numbering.map(([numId]) => numId);
    s.pendingNumbering.newDefs = [];
    s.numIdFloor = 0;
    // fontTable/docDefaults must be in place before setContent — marks bake
    // fontTable-driven factors and numbering defaults into the DOM (mirrors
    // upstream file-actions.ts open path).
    setDocFontTable(model.fontTable as never);
    const container = scrollRef.current;
    if (!container) return;
    container.innerHTML = "";
    const editor = new Editor({
      element: container,
      extensions: editorExtensions,
      content: blocksToPmDoc(
        model.blocks as never,
        model.sections as never,
      ) as never,
      editable: !s.readOnly,
      editorProps: {
        attributes: { class: "doc-page", spellcheck: "true" },
        transformPastedHTML: cleanPastedHtml,
      },
    });
    // List numbering storage is a plain Map upstream keeps in editor.storage.
    (editor.storage as unknown as Record<
      string,
      { styles?: Map<string, unknown>; defs?: Map<string, unknown>; docDefaults?: unknown }
    >).listNumbering = {
      styles: new Map(model.styles),
      defs: new Map(model.numbering),
      docDefaults: model.docDefaults,
    };
    s.editor?.destroy();
    s.editor = editor;
    setEditorInstance(editor);
    editor.on("update", () => {
      if (!s.disposed) markDirty();
    });
    editor.on("transaction", () => {
      if (s.disposed) return;
      setFormatState((prev) => {
        const next = readFormatState(editor);
        return prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
      });
    });
    setFormatState(readFormatState(editor));
    // First heading → title hint for the host chrome.
    const firstHeading = (model.blocks as { type?: string; runs?: { text?: string }[] }[]).find(
      (b) => b.type === "heading",
    );
    const titleText = (firstHeading?.runs ?? []).map((r) => r.text ?? "").join("").trim();
    if (titleText) s.bridge?.send("title", { text: titleText });
  }, [markDirty]);

  /**
   * Allocate a brand-new numbering id for a first-of-kind list (upstream
   * createNumberingDef): queued into pendingNumbering for the next save and
   * overlaid into listNumbering storage so markers render immediately.
   */
  const allocateNumId = useCallback((kind: ListKind): string | null => {
    const s = st.current;
    const editor = s.editor;
    if (!editor) return null;
    const numId = nextNumId(
      s.numberingKeys,
      s.pendingNumbering.newDefs.map((d) => d.numId),
      s.numIdFloor,
    );
    s.numIdFloor = parseInt(numId, 10) || s.numIdFloor;
    s.pendingNumbering.newDefs.push({ numId, kind });
    const store = editor.storage.listNumbering as {
      defs: Map<string, unknown>;
    };
    store.defs = new Map(store.defs).set(numId, makePendingNumberingDef(numId, kind));
    return numId;
  }, []);

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
        // Clean document: reload against the new bytes.
        s.revision = incoming;
        void loadModel().then(() => setConflict(null)).catch(() => {});
      } else if (incoming !== s.revision) {
        setConflict({ currentRevision: incoming });
        s.bridge?.send("conflict", { currentRevision: incoming });
      }
    },
    [loadModel],
  );

  const doSave = useCallback(
    async (reason: "manual" | "autosave" | "flush"): Promise<void> => {
      const s = st.current;
      if (!s.editor || s.saving || s.disposed || s.readOnly) return;
      if (!s.dirty) {
        // Nothing to write — but a host flush still needs a `saved` reply.
        if (reason === "flush") s.bridge?.send("saved", { revision: s.revision });
        return;
      }
      const generation = s.dirtyGeneration;
      s.saving = true;
      sendState();
      try {
        const plan = pmDocToSavePlan(
          s.editor.getJSON() as unknown as PmNode,
          s.blocks as never,
        ) as unknown as { saveBlocks: unknown[]; chartPatches?: unknown[]; changedCount: number };
        // Snapshot pending list definitions: the worker appends them to
        // numbering.xml via SaveOptions.numbering. On success only these are
        // retired — defs allocated during the in-flight save stay pending.
        const sentDefs = s.pendingNumbering.newDefs.map((d) => ({ ...d }));
        const sentIds = new Set(sentDefs.map((d) => d.numId));
        const body: { sessionId: string; baseRevision: string; plan: DocxSavePlan } = {
          sessionId: s.init!.sessionId,
          baseRevision: s.revision,
          plan: {
            saveBlocks: plan.saveBlocks as DocxSavePlan["saveBlocks"],
            ...(plan.chartPatches?.length
              ? { chartPatches: plan.chartPatches as DocxSavePlan["chartPatches"] }
              : {}),
            ...(sentDefs.length
              ? { options: { numbering: { newDefs: sentDefs } } }
              : {}),
          },
        };
        const res = await apiPost<{ revision: string }>("docx/save", body);
        s.revision = res.revision;
        s.pendingNumbering.newDefs = s.pendingNumbering.newDefs.filter(
          (d) => !sentIds.has(d.numId),
        );
        s.savedGeneration = Math.max(s.savedGeneration, generation);
        if (s.dirtyGeneration === generation) {
          s.dirty = false;
          setConflict(null);
        }
        // A successful save retires the autosave draft for this base.
        void fetch(`/api/documents/draft?path=${encodeURIComponent(s.init!.virtualPath)}`, {
          method: "DELETE",
        }).catch(() => {});
        s.bridge?.send("saved", { revision: res.revision });
      } catch (err) {
        const e = err as { code?: string; status?: number; currentRevision?: string; message?: string };
        if (e.code === "conflict" || e.status === 409) {
          setConflict({ currentRevision: e.currentRevision });
          s.bridge?.send("conflict", { currentRevision: e.currentRevision ?? "" });
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
    [handleIncomingRevision, sendState],
  );

  const pushDraft = useCallback(async () => {
    const s = st.current;
    if (!s.editor || !s.dirty || s.disposed) return;
    try {
      const plan = pmDocToSavePlan(
        s.editor.getJSON() as unknown as PmNode,
        s.blocks as never,
      ) as unknown as { saveBlocks: unknown[] };
      const qs = new URLSearchParams({
        path: s.init!.virtualPath,
        sessionId: s.init!.sessionId,
        baseRevision: s.revision,
      });
      await fetch(`/api/documents/draft?${qs}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: JSON.stringify({ saveBlocks: plan.saveBlocks }),
      });
    } catch {
      /* draft is best-effort */
    }
  }, []);

  // Indirection so timers/bridge handlers always see the latest callbacks.
  const doSaveRef = useRef(doSave);
  const pushDraftRef = useRef(pushDraft);
  doSaveRef.current = doSave;
  pushDraftRef.current = pushDraft;

  const onBridgeMessage = useCallback(
    (msg: BridgeMessage) => {
      const s = st.current;
      switch (msg.type) {
        case "init": {
          // Host may deliver init twice (its iframe-load hook + our request).
          if (s.init) break;
          s.init = msg as unknown as InitMsg;
          s.revision = s.init.revision;
          s.readOnly = Boolean(s.init.readOnlyReason);
          setModuleLang(nearestEditorLang(s.init.locale));
          document.documentElement.dataset.theme = s.init.theme;
          void loadModel()
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
          void doSaveRef.current("flush").catch((e: Error) =>
            sendState({ error: e.message }),
          );
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
          s.editor?.destroy();
          break;
      }
    },
    [handleIncomingRevision, loadModel, sendState],
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
    // Handshake: ask the host for `init`. The host's iframe-onLoad send races
    // this listener's installation, so the explicit request is what actually
    // unblocks loading.
    bridge.send("request", { action: "init" });

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
      st.current.editor?.destroy();
    };
  }, [onBridgeMessage]);

  return (
    <div className="doc-editor-frame">
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
                  setConflict(null);
                  void loadModel().then(() =>
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
            <button
              type="button"
              onClick={() => st.current.bridge?.send("request", { action: "save-copy" })}
            >
              {t("docxEditor:saveACopy")}
            </button>
          </span>
        </div>
      )}
      {status === "loading" && (
        <div className="doc-editor-frame-status">{t("docxEditor:loading")}</div>
      )}
      {status === "error" && (
        <div className="doc-editor-frame-status">{errorText ?? t("docxEditor:loadFailed")}</div>
      )}
      {status === "ready" && (
        <DocxToolbar
          editor={editorInstance}
          readOnly={uiState.readOnly}
          formatState={formatState}
          onSave={() => void doSaveRef.current("manual")}
          dirty={uiState.dirty}
          saving={uiState.saving}
          allocateNumId={allocateNumId}
        />
      )}
      <div ref={scrollRef} className="doc-editor-scroll" />
    </div>
  );
}
