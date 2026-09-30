import { XlsxSidecarClient } from "../../src/vendor/genoffice/apps/sheets/src/main/xlsx-sidecar-client";
import { saveWorkbookViaSidecar } from "../../src/vendor/genoffice/packages/xlsx-gateway/src/gateway/xlsx-package-io";
import type {
  CellEdit,
  SheetStructuralOps,
} from "../../src/vendor/genoffice/packages/xlsx-gateway/src/gateway/xlsx-gateway";
import { DocumentError } from "../../src/lib/documents/errors";
import type {
  XlsxDocumentModel,
  XlsxInspectResult,
  XlsxSavePlan,
  XlsxSheetModel,
  XlsxStyleModel,
} from "../../src/lib/documents/types";
import { xlsxSidecarAvailable, xlsxSidecarPath } from "./xlsx-sidecar-path";

const MAX_RANGE_CELLS = 100_000;
const MAX_LOADED_CELLS = 1_000_000;
const INDEX_WAIT_ATTEMPTS = 120;

interface SidecarStyle extends XlsxStyleModel {
  [key: string]: unknown;
}

interface SidecarSheet {
  id: string;
  name: string;
  rowCount: number;
  columnCount: number;
  columnWidths?: XlsxSheetModel["columnWidths"];
  hidden?: boolean;
  showGridLines?: boolean;
}

interface SidecarMetadata {
  sessionId: string;
  name: string;
  activeTab?: number;
  styles?: SidecarStyle[];
  sheets: SidecarSheet[];
}

interface SidecarRange {
  cells: {
    row: number;
    column: number;
    value?: string | number | boolean | null;
    formula?: string;
    styleIndex?: number;
  }[];
  rows?: XlsxSheetModel["rows"];
  merges?: XlsxSheetModel["merges"];
  indexedThroughRow?: number;
  indexingComplete: boolean;
}

let client: XlsxSidecarClient | null = null;
process.once("exit", () => client?.stop());
process.once("SIGTERM", () => {
  client?.stop();
  process.exit(0);
});

export function prewarmXlsxSidecar(): { available: boolean } {
  if (!xlsxSidecarAvailable()) return { available: false };
  sidecar().start();
  return { available: true };
}

export function stopXlsxSidecarForTest(): void {
  client?.stop();
  client = null;
}

function sidecar(): XlsxSidecarClient {
  if (!xlsxSidecarAvailable()) {
    throw new DocumentError(
      "unsupported",
      `XLSX editing helper is unavailable for ${process.platform}-${process.arch}`,
    );
  }
  return (client ??= new XlsxSidecarClient(xlsxSidecarPath()));
}

async function openWorkbook(inputPath: string): Promise<SidecarMetadata> {
  return (await sidecar().open(inputPath, "en")) as SidecarMetadata;
}

async function readStableRange(
  sessionId: string,
  sheetId: string,
  range: { startRow: number; endRow: number; startColumn: number; endColumn: number },
): Promise<SidecarRange> {
  let result: SidecarRange | null = null;
  for (let attempt = 0; attempt < INDEX_WAIT_ATTEMPTS; attempt++) {
    result = (await sidecar().readRange({ sessionId, sheetId, range })) as SidecarRange;
    if (result.indexingComplete || (result.indexedThroughRow ?? -1) >= range.endRow) return result;
  }
  throw new DocumentError("worker-failed", "XLSX worksheet indexing did not finish in time");
}

async function withWorkbook<T>(inputPath: string, fn: (metadata: SidecarMetadata) => Promise<T>): Promise<T> {
  const metadata = await openWorkbook(inputPath);
  try {
    return await fn(metadata);
  } finally {
    await sidecar().close(metadata.sessionId).catch(() => {});
  }
}

export async function inspectXlsx(inputPath: string): Promise<XlsxInspectResult> {
  return withWorkbook(inputPath, async (metadata) => ({
    format: "xlsx",
    name: metadata.name,
    sheets: metadata.sheets.map((sheet) => ({
      id: sheet.id,
      name: sheet.name,
      rows: sheet.rowCount,
      columns: sheet.columnCount,
    })),
    cellCount: metadata.sheets.reduce(
      (total, sheet) => total + sheet.rowCount * sheet.columnCount,
      0,
    ),
  }));
}

export async function loadXlsx(inputPath: string): Promise<XlsxDocumentModel> {
  return withWorkbook(inputPath, async (metadata) => {
    let remaining = MAX_LOADED_CELLS;
    let truncated = false;
    const sheets: XlsxSheetModel[] = [];

    for (const sheet of metadata.sheets) {
      const columns = Math.max(1, sheet.columnCount);
      const loadedRows = Math.min(sheet.rowCount, Math.floor(remaining / columns));
      if (loadedRows < sheet.rowCount) truncated = true;
      remaining -= loadedRows * columns;
      const cells: XlsxSheetModel["cells"] = [];
      const rows = new Map<number, XlsxSheetModel["rows"][number]>();
      const merges = new Map<string, XlsxSheetModel["merges"][number]>();
      const rowsPerChunk = Math.max(1, Math.floor(MAX_RANGE_CELLS / columns));

      for (let startRow = 0; startRow < loadedRows; startRow += rowsPerChunk) {
        const endRow = Math.min(loadedRows - 1, startRow + rowsPerChunk - 1);
        const result = await readStableRange(metadata.sessionId, sheet.id, {
          startRow,
          endRow,
          startColumn: 0,
          endColumn: columns - 1,
        });
        for (const cell of result.cells) {
          cells.push({
            row: cell.row,
            column: cell.column,
            value: cell.value ?? null,
            ...(cell.formula ? { formula: cell.formula } : {}),
            ...(cell.styleIndex === undefined ? {} : { styleIndex: cell.styleIndex }),
          });
        }
        for (const row of result.rows ?? []) rows.set(row.row, row);
        for (const merge of result.merges ?? []) {
          merges.set(
            `${merge.startRow}:${merge.startColumn}:${merge.endRow}:${merge.endColumn}`,
            merge,
          );
        }
      }
      sheets.push({
        id: sheet.id,
        name: sheet.name,
        rowCount: sheet.rowCount,
        columnCount: sheet.columnCount,
        cells,
        rows: [...rows.values()],
        merges: [...merges.values()],
        columnWidths: sheet.columnWidths ?? [],
        hidden: Boolean(sheet.hidden),
        showGridLines: sheet.showGridLines !== false,
      });
    }

    return {
      format: "xlsx",
      name: metadata.name,
      activeTab: metadata.activeTab ?? 0,
      styles: (metadata.styles ?? []) as XlsxStyleModel[],
      sheets,
      truncated,
    };
  });
}

export async function readXlsx(inputPath: string): Promise<{ text: string }> {
  const model = await loadXlsx(inputPath);
  const text = model.sheets
    .map((sheet) => {
      const rows = new Map<number, Map<number, string>>();
      for (const cell of sheet.cells) {
        const row = rows.get(cell.row) ?? new Map<number, string>();
        row.set(cell.column, cell.formula ?? String(cell.value ?? ""));
        rows.set(cell.row, row);
      }
      const lines = [...rows]
        .sort(([a], [b]) => a - b)
        .map(([, row]) => {
          const last = Math.max(-1, ...row.keys());
          return Array.from({ length: last + 1 }, (_, column) => row.get(column) ?? "").join("\t");
        });
      return `## ${sheet.name}\n${lines.join("\n")}`;
    })
    .join("\n\n");
  return { text };
}

export async function saveXlsx(
  inputPath: string,
  outputPath: string,
  plan: XlsxSavePlan,
): Promise<{ size: number }> {
  if (!plan || !Array.isArray(plan.edits)) {
    throw new DocumentError("invalid", "XLSX save plan is malformed");
  }
  const metadata = await openWorkbook(inputPath);
  try {
    const nameById = new Map(metadata.sheets.map((sheet) => [sheet.id, sheet.name]));
    for (const addition of plan.sheetPlan?.additions ?? []) {
      nameById.set(addition.sheetId, addition.name);
    }
    const edits: CellEdit[] = plan.edits.map((edit) => {
      const sheetName = nameById.get(edit.sheetId);
      if (!sheetName) throw new DocumentError("invalid", `Unknown worksheet ${edit.sheetId}`);
      return {
        sheetName,
        row: edit.row,
        column: edit.column,
        writeValue: edit.writeValue,
        cell: { value: edit.value, ...(edit.formula ? { formula: edit.formula } : {}) },
        ...(edit.style ? { style: edit.style as CellEdit["style"] } : {}),
        ...(edit.styleReset ? { styleReset: true } : {}),
      };
    });
    const sheetPlan = plan.sheetPlan
      ? {
          ...plan.sheetPlan,
          additions: plan.sheetPlan.additions.map((addition) => ({
            name: addition.name,
            ...(addition.sourceSheetName
              ? { sourceSheetName: addition.sourceSheetName }
              : {}),
          })),
        }
      : undefined;
    const structuralOps: SheetStructuralOps[] = (plan.structuralOps ?? []).map((entry) => {
      const sheetName = nameById.get(entry.sheetId);
      if (!sheetName) throw new DocumentError("invalid", `Unknown worksheet ${entry.sheetId}`);
      return { sheetName, ops: entry.ops as SheetStructuralOps["ops"] };
    });
    await saveWorkbookViaSidecar({
      client: sidecar(),
      sourcePath: inputPath,
      targetPath: outputPath,
      edits,
      ...(structuralOps.length ? { structuralOps } : {}),
      ...(sheetPlan ? { sheetPlan } : {}),
    });
    const { size } = await import("node:fs/promises").then((fs) => fs.stat(outputPath));
    return { size };
  } finally {
    await sidecar().close(metadata.sessionId).catch(() => {});
  }
}
