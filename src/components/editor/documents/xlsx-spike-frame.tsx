"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LocaleType, mergeLocales, type IWorkbookData } from "@univerjs/core";
import { UniverSheetsConditionalFormattingPreset } from "@univerjs/preset-sheets-conditional-formatting";
import ConditionalFormattingEnUS from "@univerjs/preset-sheets-conditional-formatting/locales/en-US";
import { UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import SheetsCoreEnUS from "@univerjs/preset-sheets-core/locales/en-US";
import { UniverSheetsDataValidationPreset } from "@univerjs/preset-sheets-data-validation";
import DataValidationEnUS from "@univerjs/preset-sheets-data-validation/locales/en-US";
import { UniverSheetsDrawingPreset } from "@univerjs/preset-sheets-drawing";
import { UniverSheetsFilterPreset } from "@univerjs/preset-sheets-filter";
import FilterEnUS from "@univerjs/preset-sheets-filter/locales/en-US";
import { UniverSheetsFindReplacePreset } from "@univerjs/preset-sheets-find-replace";
import FindReplaceEnUS from "@univerjs/preset-sheets-find-replace/locales/en-US";
import { UniverSheetsNotePreset } from "@univerjs/preset-sheets-note";
import NoteEnUS from "@univerjs/preset-sheets-note/locales/en-US";
import { UniverSheetsSortPreset } from "@univerjs/preset-sheets-sort";
import SortEnUS from "@univerjs/preset-sheets-sort/locales/en-US";
import { UniverSheetsTablePreset } from "@univerjs/preset-sheets-table";
import TableEnUS from "@univerjs/preset-sheets-table/locales/en-US";
import { greenTheme } from "@univerjs/themes";

import "@univerjs/preset-sheets-core/lib/index.css";
import "@univerjs/preset-sheets-conditional-formatting/lib/index.css";
import "@univerjs/preset-sheets-data-validation/lib/index.css";
import "@univerjs/preset-sheets-drawing/lib/index.css";
import "@univerjs/preset-sheets-filter/lib/index.css";
import "@univerjs/preset-sheets-find-replace/lib/index.css";
import "@univerjs/preset-sheets-note/lib/index.css";
import "@univerjs/preset-sheets-sort/lib/index.css";
import "@univerjs/preset-sheets-table/lib/index.css";

import { createFrameBridge, type BridgeMessage } from "@/lib/documents/frame-bridge";
import type { XlsxDocumentModel } from "@/lib/documents/types";
import { createXlsxUniver } from "./xlsx-create-univer";
import { xlsxModelToUniver, xlsxSavePlan } from "./xlsx-model";

interface InitMessage {
  sessionId: string;
  revision: string;
  virtualPath: string;
  readOnlyReason?: string;
  theme: "light" | "dark";
}

type Runtime = ReturnType<typeof createXlsxUniver>;

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

function createRuntime(darkMode: boolean): Runtime {
  return createXlsxUniver({
    theme: greenTheme,
    darkMode,
    locale: LocaleType.EN_US,
    locales: {
      [LocaleType.EN_US]: mergeLocales(
        SheetsCoreEnUS,
        ConditionalFormattingEnUS,
        DataValidationEnUS,
        FilterEnUS,
        FindReplaceEnUS,
        NoteEnUS,
        SortEnUS,
        TableEnUS,
      ),
    },
    presets: [
      UniverSheetsCorePreset({
        container: "xlsx-univer-container",
        header: true,
        toolbar: true,
        contextMenu: true,
        formulaBar: true,
        footer: { sheetBar: true, statisticBar: true, menus: true, zoomSlider: true },
        sheets: { isRowStylePrecedeColumnStyle: true },
      }),
      UniverSheetsDrawingPreset(),
      UniverSheetsConditionalFormattingPreset(),
      UniverSheetsFilterPreset(),
      UniverSheetsDataValidationPreset(),
      UniverSheetsNotePreset(),
      UniverSheetsFindReplacePreset(),
      UniverSheetsSortPreset(),
      UniverSheetsTablePreset(),
    ],
  });
}

/** XLSX editor frame: real sidecar model in, gateway save plan out. */
export default function XlsxEditorFrame() {
  const [error, setError] = useState<string | null>(null);
  const state = useRef({
    init: null as InitMessage | null,
    bridge: null as ReturnType<typeof createFrameBridge> | null,
    runtime: null as Runtime | null,
    model: null as XlsxDocumentModel | null,
    revision: "",
    dirty: false,
    saving: false,
    disposed: false,
    autosave: null as ReturnType<typeof setTimeout> | null,
    commandDisposable: null as { dispose(): void } | null,
    loadingRevision: "",
    loadedRevision: "",
  });
  const saveRef = useRef<(flush?: boolean) => Promise<void>>(async () => {});

  const sendState = useCallback(() => {
    const s = state.current;
    s.bridge?.send("state", { dirty: s.dirty, saving: s.saving });
  }, []);

  const markDirty = useCallback(() => {
    const s = state.current;
    if (s.disposed || s.dirty) return;
    s.dirty = true;
    sendState();
    if (s.autosave) clearTimeout(s.autosave);
    s.autosave = setTimeout(() => void saveRef.current(), 2000);
  }, [sendState]);

  const load = useCallback(async () => {
    const s = state.current;
    if (!s.init) return;
    const targetRevision = s.revision;
    if (
      s.loadingRevision === targetRevision ||
      (s.loadedRevision === targetRevision && s.runtime)
    ) {
      return;
    }
    s.loadingRevision = targetRevision;
    setError(null);
    let model: XlsxDocumentModel;
    try {
      model = await apiPost<XlsxDocumentModel>("xlsx/load", { sessionId: s.init.sessionId });
    } catch (cause) {
      s.loadingRevision = "";
      throw cause;
    }
    s.model = model;
    s.loadedRevision = targetRevision;
    s.loadingRevision = "";
    s.commandDisposable?.dispose();
    s.runtime?.univer.dispose();
    performance.mark("cabinet-xlsx-init-start");
    const runtime = createRuntime(s.init.theme === "dark");
    const workbook = runtime.univerAPI.createUniverSheet(xlsxModelToUniver(model));
    s.runtime = runtime;
    if (model.truncated) workbook.setEditable(false);
    else {
      s.commandDisposable = runtime.univerAPI.onCommandExecuted((command) => {
        if (String(command.id).includes("mutation")) markDirty();
      });
    }
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        performance.mark("cabinet-xlsx-ready");
        performance.measure("cabinet-xlsx-init", "cabinet-xlsx-init-start", "cabinet-xlsx-ready");
        document.documentElement.dataset.xlsxReady = "true";
        s.bridge?.send("ready");
        s.bridge?.send("title", { text: model.name });
        if (model.truncated) {
          s.bridge?.send("state", {
            dirty: false,
            saving: false,
            error: "Workbook is too large to load completely; edits are disabled.",
          });
        }
      }),
    );
  }, [markDirty]);

  const save = useCallback(
    async (flush = false) => {
      const s = state.current;
      if (!s.init || !s.runtime || !s.model || s.saving || s.disposed) return;
      if (!s.dirty) {
        if (flush) s.bridge?.send("saved", { revision: s.revision });
        return;
      }
      if (s.model.truncated) return;
      s.saving = true;
      sendState();
      try {
        const workbook = s.runtime.univerAPI.getActiveWorkbook();
        if (!workbook) throw new Error("Workbook is not ready");
        const plan = xlsxSavePlan(s.model, workbook.save() as IWorkbookData);
        const result = await apiPost<{ revision: string }>("xlsx/save", {
          sessionId: s.init.sessionId,
          baseRevision: s.revision,
          plan,
        });
        s.revision = result.revision;
        s.dirty = false;
        s.model = await apiPost<XlsxDocumentModel>("xlsx/load", { sessionId: s.init.sessionId });
        s.loadedRevision = result.revision;
        s.bridge?.send("saved", { revision: result.revision });
      } catch (cause) {
        const failure = cause as Error & { code?: string; currentRevision?: string };
        if (failure.code === "conflict") {
          s.bridge?.send("conflict", { currentRevision: failure.currentRevision });
        } else {
          setError(failure.message);
          s.bridge?.send("state", { dirty: true, saving: false, error: failure.message });
        }
      } finally {
        s.saving = false;
        sendState();
      }
    },
    [sendState],
  );
  saveRef.current = save;

  useEffect(() => {
    const s = state.current;
    s.disposed = false;
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const channel = hash.get("channel") ?? "";
    const bridge = createFrameBridge(channel, (message: BridgeMessage) => {
      if (message.type === "init") {
        s.init = message as unknown as InitMessage;
        s.revision = String(message.revision ?? "");
        void load().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
      } else if (message.type === "save-request") {
        void saveRef.current(true);
      } else if (message.type === "revision-changed") {
        const incoming = String(message.revision ?? "");
        if (incoming && incoming !== s.revision) {
          if (s.dirty) bridge.send("conflict", { currentRevision: incoming });
          else {
            s.revision = incoming;
            void load().catch(() => {});
          }
        }
      } else if (message.type === "dispose") {
        s.disposed = true;
      }
    });
    s.bridge = bridge;
    bridge.send("request", { action: "init" });
    return () => {
      s.disposed = true;
      if (s.autosave) clearTimeout(s.autosave);
      s.commandDisposable?.dispose();
      s.runtime?.univer.dispose();
      bridge.dispose();
      delete document.documentElement.dataset.xlsxReady;
    };
  }, [load]);

  return (
    <main style={{ width: "100vw", height: "100vh", background: "var(--surface)" }}>
      {error ? (
        <div role="alert" style={{ position: "absolute", zIndex: 100, padding: 12, color: "var(--danger, var(--text))" }}>
          {error}
        </div>
      ) : null}
      <div id="xlsx-univer-container" style={{ width: "100%", height: "100%" }} />
    </main>
  );
}
