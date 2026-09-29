"use client";

import { useEffect, useRef } from "react";
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

import { createXlsxUniver } from "./xlsx-create-univer";

const SPIKE_WORKBOOK: Partial<IWorkbookData> = {
  id: "cabinet-xlsx-spike",
  name: "Cabinet XLSX spike",
  locale: LocaleType.EN_US,
  sheetOrder: ["sheet-1", "sheet-2"],
  styles: {},
  sheets: {
    "sheet-1": {
      id: "sheet-1",
      name: "Budget",
      rowCount: 200,
      columnCount: 40,
      cellData: {
        0: { 0: { v: "Cabinet XLSX / Univer Next-build spike" } },
        2: {
          0: { v: "Metric" },
          1: { v: "Budget" },
          2: { v: "Measured after production build" },
        },
        3: { 0: { v: "Frame JS gzip" }, 1: { v: "≤ 4 MB" } },
        4: { 0: { v: "Warm cold-open" }, 1: { v: "≤ 3 s" } },
      },
    },
    "sheet-2": {
      id: "sheet-2",
      name: "Second sheet",
      rowCount: 100,
      columnCount: 26,
      cellData: { 0: { 0: { v: "The complete preset stack initialized." } } },
    },
  },
};

/**
 * Phase 3 budget frame: the exact free Univer preset stack used by GenOffice
 * Sheets at the pinned commit, but without its Electron/AI/gateway shell.
 */
export default function XlsxSpikeFrame() {
  const errorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    performance.mark("cabinet-xlsx-init-start");
    const dark =
      document.documentElement.dataset.theme === "dark" ||
      (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
    let runtime: ReturnType<typeof createXlsxUniver> | null = null;
    try {
      runtime = createXlsxUniver({
        theme: greenTheme,
        darkMode: dark,
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
      runtime.univerAPI.createUniverSheet(SPIKE_WORKBOOK);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          performance.mark("cabinet-xlsx-ready");
          performance.measure(
            "cabinet-xlsx-init",
            "cabinet-xlsx-init-start",
            "cabinet-xlsx-ready",
          );
          document.documentElement.dataset.xlsxReady = "true";
          window.dispatchEvent(new Event("cabinet:xlsx-ready"));
        }),
      );
    } catch (cause) {
      if (errorRef.current) {
        errorRef.current.textContent = cause instanceof Error ? cause.message : String(cause);
        errorRef.current.hidden = false;
      }
      document.documentElement.dataset.xlsxError = "true";
    }
    return () => {
      delete document.documentElement.dataset.xlsxReady;
      delete document.documentElement.dataset.xlsxError;
      runtime?.univer.dispose();
    };
  }, []);

  return (
    <main style={{ width: "100vw", height: "100vh", background: "var(--surface)" }}>
      <div
        ref={errorRef}
        role="alert"
        hidden
        style={{ padding: 24, color: "var(--danger, var(--text))" }}
      />
      <div id="xlsx-univer-container" style={{ width: "100%", height: "100%" }} />
    </main>
  );
}
