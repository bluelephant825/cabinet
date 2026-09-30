import {
  BooleanNumber,
  BorderStyleTypes,
  HorizontalAlign,
  LocaleType,
  VerticalAlign,
  WrapStrategy,
  type ICellData,
  type IStyleData,
  type IWorkbookData,
} from "@univerjs/core";

import type {
  XlsxDocumentModel,
  XlsxSavePlan,
  XlsxSheetModel,
  XlsxStructuralOps,
  XlsxStyleModel,
} from "@/lib/documents/types";

const color = (value: string | undefined) => (value ? { rgb: value } : undefined);
const UNIVER_BORDER: Record<string, BorderStyleTypes> = {
  thin: BorderStyleTypes.THIN,
  hair: BorderStyleTypes.HAIR,
  dotted: BorderStyleTypes.DOTTED,
  dashed: BorderStyleTypes.DASHED,
  dashDot: BorderStyleTypes.DASH_DOT,
  dashDotDot: BorderStyleTypes.DASH_DOT_DOT,
  double: BorderStyleTypes.DOUBLE,
  medium: BorderStyleTypes.MEDIUM,
  mediumDashed: BorderStyleTypes.MEDIUM_DASHED,
  mediumDashDot: BorderStyleTypes.MEDIUM_DASH_DOT,
  mediumDashDotDot: BorderStyleTypes.MEDIUM_DASH_DOT_DOT,
  slantDashDot: BorderStyleTypes.SLANT_DASH_DOT,
  thick: BorderStyleTypes.THICK,
};

export function xlsxStyleToUniver(style: XlsxStyleModel | undefined): IStyleData | undefined {
  if (!style) return undefined;
  const horizontal: Record<string, HorizontalAlign> = {
    left: HorizontalAlign.LEFT,
    center: HorizontalAlign.CENTER,
    right: HorizontalAlign.RIGHT,
    justify: HorizontalAlign.JUSTIFIED,
    distributed: HorizontalAlign.DISTRIBUTED,
  };
  const vertical: Record<string, VerticalAlign> = {
    top: VerticalAlign.TOP,
    center: VerticalAlign.MIDDLE,
    bottom: VerticalAlign.BOTTOM,
  };
  const border = (edge: { style: string; color?: string } | undefined) =>
    edge && UNIVER_BORDER[edge.style]
      ? { s: UNIVER_BORDER[edge.style], cl: { rgb: edge.color ?? "#000000" } }
      : undefined;
  const borders = {
    ...(border(style.borderTop) ? { t: border(style.borderTop) } : {}),
    ...(border(style.borderBottom) ? { b: border(style.borderBottom) } : {}),
    ...(border(style.borderLeft) ? { l: border(style.borderLeft) } : {}),
    ...(border(style.borderRight) ? { r: border(style.borderRight) } : {}),
  };
  return {
    ...(style.fontFamily ? { ff: style.fontFamily } : {}),
    ...(style.fontSize ? { fs: style.fontSize } : {}),
    bl: style.bold ? BooleanNumber.TRUE : BooleanNumber.FALSE,
    it: style.italic ? BooleanNumber.TRUE : BooleanNumber.FALSE,
    ...(style.underline ? { ul: { s: BooleanNumber.TRUE } } : {}),
    ...(style.strikethrough ? { st: { s: BooleanNumber.TRUE } } : {}),
    ...(style.fontColor ? { cl: color(style.fontColor) } : {}),
    ...(style.fillColor ? { bg: color(style.fillColor) } : {}),
    ...(style.numberFormat ? { n: { pattern: style.numberFormat } } : {}),
    ...(style.horizontalAlignment && horizontal[style.horizontalAlignment] !== undefined
      ? { ht: horizontal[style.horizontalAlignment] }
      : {}),
    ...(style.verticalAlignment && vertical[style.verticalAlignment] !== undefined
      ? { vt: vertical[style.verticalAlignment] }
      : {}),
    tb: style.wrapText ? WrapStrategy.WRAP : WrapStrategy.OVERFLOW,
    ...(Object.keys(borders).length ? { bd: borders } : {}),
    ...(style.textRotation === 255
      ? { tr: { a: 0, v: BooleanNumber.TRUE } }
      : style.textRotation
        ? { tr: { a: style.textRotation } }
        : {}),
  };
}

function sheetData(sheet: XlsxSheetModel, styles: XlsxStyleModel[]) {
  const cellData: Record<number, Record<number, ICellData>> = {};
  for (const cell of sheet.cells) {
    (cellData[cell.row] ??= {})[cell.column] = {
      ...(cell.value !== null ? { v: cell.value } : {}),
      ...(cell.formula ? { f: cell.formula } : {}),
      ...(cell.styleIndex === undefined
        ? {}
        : { s: xlsxStyleToUniver(styles[cell.styleIndex]) }),
    };
  }
  const rowData = Object.fromEntries(
    sheet.rows.map((row) => [
      row.row,
      {
        ...(row.height === undefined ? {} : { h: Math.round((row.height * 96) / 72) }),
        ...(row.hidden ? { hd: BooleanNumber.TRUE } : {}),
      },
    ]),
  );
  const columnData: Record<number, { w?: number; hd?: BooleanNumber }> = {};
  for (const span of sheet.columnWidths) {
    for (let column = span.startColumn; column <= span.endColumn; column++) {
      columnData[column] = {
        ...(span.width === undefined ? {} : { w: Math.max(20, Math.round(span.width * 7 + 5)) }),
        ...(span.hidden ? { hd: BooleanNumber.TRUE } : {}),
      };
    }
  }
  return {
    id: sheet.id,
    name: sheet.name,
    rowCount: Math.max(100, sheet.rowCount),
    columnCount: Math.max(26, sheet.columnCount),
    cellData,
    rowData,
    columnData,
    mergeData: sheet.merges,
    showGridlines: sheet.showGridLines ? 1 : 0,
    hidden: sheet.hidden ? 1 : 0,
  };
}

export function xlsxModelToUniver(model: XlsxDocumentModel): Partial<IWorkbookData> {
  return {
    id: "cabinet-xlsx",
    name: model.name,
    locale: LocaleType.EN_US,
    sheetOrder: model.sheets.map((sheet) => sheet.id),
    styles: {},
    sheets: Object.fromEntries(
      model.sheets.map((sheet) => [sheet.id, sheetData(sheet, model.styles)]),
    ),
  };
}

function resolvedStyle(snapshot: IWorkbookData, cell: ICellData | undefined): IStyleData | undefined {
  const style = cell?.s;
  if (!style) return undefined;
  if (typeof style === "string") return snapshot.styles?.[style] as IStyleData | undefined;
  return style as IStyleData;
}

function rgb(input: unknown): string | null | undefined {
  if (input == null) return undefined;
  if (typeof input !== "object") return undefined;
  const value = (input as { rgb?: unknown }).rgb;
  return typeof value === "string" && /^#[0-9A-Fa-f]{6}$/.test(value) ? value : undefined;
}

const BORDER_STYLE = new Map<BorderStyleTypes, string>([
  [BorderStyleTypes.THIN, "thin"],
  [BorderStyleTypes.HAIR, "hair"],
  [BorderStyleTypes.DOTTED, "dotted"],
  [BorderStyleTypes.DASHED, "dashed"],
  [BorderStyleTypes.DASH_DOT, "dashDot"],
  [BorderStyleTypes.DASH_DOT_DOT, "dashDotDot"],
  [BorderStyleTypes.DOUBLE, "double"],
  [BorderStyleTypes.MEDIUM, "medium"],
  [BorderStyleTypes.MEDIUM_DASHED, "mediumDashed"],
  [BorderStyleTypes.MEDIUM_DASH_DOT, "mediumDashDot"],
  [BorderStyleTypes.MEDIUM_DASH_DOT_DOT, "mediumDashDotDot"],
  [BorderStyleTypes.SLANT_DASH_DOT, "slantDashDot"],
  [BorderStyleTypes.THICK, "thick"],
]);

function borderEdit(edge: unknown): unknown {
  if (!edge || typeof edge !== "object") return null;
  const value = edge as { s?: BorderStyleTypes; cl?: unknown };
  const borderStyle = value.s == null ? undefined : BORDER_STYLE.get(value.s);
  if (!borderStyle) return null;
  return { style: borderStyle, ...(rgb(value.cl) ? { color: rgb(value.cl) } : {}) };
}

function styleToEdit(style: IStyleData | undefined): Record<string, unknown> | undefined {
  if (!style) return undefined;
  const horizontal = new Map<HorizontalAlign, string>([
    [HorizontalAlign.LEFT, "left"],
    [HorizontalAlign.CENTER, "center"],
    [HorizontalAlign.RIGHT, "right"],
    [HorizontalAlign.JUSTIFIED, "justify"],
    [HorizontalAlign.DISTRIBUTED, "distributed"],
  ]);
  const vertical = new Map<VerticalAlign, string>([
    [VerticalAlign.TOP, "top"],
    [VerticalAlign.MIDDLE, "center"],
    [VerticalAlign.BOTTOM, "bottom"],
  ]);
  return {
    bold: style.bl === BooleanNumber.TRUE,
    italic: style.it === BooleanNumber.TRUE,
    underline: Boolean(style.ul && style.ul.s !== BooleanNumber.FALSE),
    strikethrough: Boolean(style.st && style.st.s !== BooleanNumber.FALSE),
    ...(style.ff ? { fontFamily: style.ff } : {}),
    ...(style.fs ? { fontSize: style.fs } : {}),
    fontColor: rgb(style.cl) ?? null,
    fillColor: rgb(style.bg) ?? null,
    ...(style.n?.pattern ? { numberFormat: style.n.pattern } : {}),
    ...(style.ht != null && horizontal.has(style.ht)
      ? { horizontalAlignment: horizontal.get(style.ht) }
      : {}),
    ...(style.vt != null && vertical.has(style.vt)
      ? { verticalAlignment: vertical.get(style.vt) }
      : {}),
    wrapText: style.tb === WrapStrategy.WRAP,
    borderTop: borderEdit(style.bd?.t),
    borderBottom: borderEdit(style.bd?.b),
    borderLeft: borderEdit(style.bd?.l),
    borderRight: borderEdit(style.bd?.r),
    ...(style.tr?.v === BooleanNumber.TRUE
      ? { textRotation: 255 }
      : style.tr?.a
        ? { textRotation: Math.max(0, Math.min(180, Math.round(style.tr.a))) }
        : {}),
  };
}

const stable = (value: unknown) => JSON.stringify(value ?? null);

function baselineCells(sheet: XlsxSheetModel, styles: XlsxStyleModel[]) {
  return new Map(
    sheet.cells.map((cell) => [
      `${cell.row}:${cell.column}`,
      {
        value: cell.value,
        formula: cell.formula,
        style: styleToEdit(xlsxStyleToUniver(styles[cell.styleIndex ?? -1])),
      },
    ]),
  );
}

/** Diff a Univer snapshot against the worker model into gateway cell/sheet edits. */
export function xlsxSavePlan(model: XlsxDocumentModel, snapshot: IWorkbookData): XlsxSavePlan {
  const edits: XlsxSavePlan["edits"] = [];
  const sourceById = new Map(model.sheets.map((sheet) => [sheet.id, sheet]));
  const sheets = snapshot.sheets ?? {};

  for (const [sheetId, sheet] of Object.entries(sheets)) {
    const source = sourceById.get(sheetId);
    const before = source ? baselineCells(source, model.styles) : new Map();
    const seen = new Set<string>();
    for (const [rowText, columns] of Object.entries(sheet.cellData ?? {})) {
      const row = Number(rowText);
      for (const [columnText, cell] of Object.entries(
        (columns ?? {}) as Record<string, ICellData>,
      )) {
        const column = Number(columnText);
        const key = `${row}:${column}`;
        seen.add(key);
        const value =
          typeof cell.v === "string" || typeof cell.v === "number" || typeof cell.v === "boolean"
            ? cell.v
            : null;
        const formula = typeof cell.f === "string" && cell.f ? cell.f : undefined;
        const style = styleToEdit(resolvedStyle(snapshot, cell));
        const old = before.get(key);
        const valueChanged = !old || old.value !== value || old.formula !== formula;
        const styleChanged = stable(old?.style) !== stable(style);
        if (valueChanged || styleChanged) {
          edits.push({
            sheetId,
            row,
            column,
            writeValue: valueChanged,
            value,
            ...(formula ? { formula } : {}),
            ...(styleChanged && style ? { style } : {}),
            ...(styleChanged && !style ? { styleReset: true } : {}),
          });
        }
      }
    }
    for (const [key, old] of before) {
      if (seen.has(key)) continue;
      const [row, column] = key.split(":").map(Number);
      if (old.value !== null || old.formula) {
        edits.push({ sheetId, row, column, writeValue: true, value: null });
      }
    }
  }

  const structuralOps: XlsxStructuralOps[] = [];
  for (const source of model.sheets) {
    const current = sheets[source.id];
    if (!current) continue;
    const key = (range: { startRow: number; endRow: number; startColumn: number; endColumn: number }) =>
      `${range.startRow}:${range.startColumn}:${range.endRow}:${range.endColumn}`;
    const before = new Map(source.merges.map((range) => [key(range), range]));
    const after = new Map((current.mergeData ?? []).map((range) => [key(range), range]));
    const ops: XlsxStructuralOps["ops"] = [];
    for (const [id, range] of before) {
      if (!after.has(id)) ops.push({ kind: "unmerge-cells", range });
    }
    for (const [id, range] of after) {
      if (!before.has(id)) ops.push({ kind: "merge-cells", range });
    }
    if (ops.length) structuralOps.push({ sheetId: source.id, ops });
  }

  const sourceNames = new Map(model.sheets.map((sheet) => [sheet.id, sheet.name]));
  const additions = Object.entries(sheets)
    .filter(([id]) => !sourceNames.has(id))
    .map(([sheetId, sheet]) => ({ sheetId, name: sheet.name ?? "Sheet" }));
  const renames = Object.entries(sheets).flatMap(([id, sheet]) => {
    const before = sourceNames.get(id);
    return before && sheet.name && before !== sheet.name
      ? [{ sheetName: before, newName: sheet.name }]
      : [];
  });
  const removals = model.sheets
    .filter((sheet) => !sheets[sheet.id])
    .map((sheet) => sheet.name);
  const oldOrder = model.sheets.map((sheet) => sheet.id);
  const order = snapshot.sheetOrder ?? Object.keys(sheets);
  const orderChanged = stable(oldOrder) !== stable(order);
  const sheetPlan =
    additions.length || renames.length || removals.length || orderChanged
      ? {
          additions,
          renames,
          removals,
          hiddenChanges: [],
          orderChanged,
          order: order.map((id) => sourceNames.get(id) ?? sheets[id]?.name ?? id),
        }
      : undefined;
  return {
    edits,
    ...(structuralOps.length ? { structuralOps } : {}),
    ...(sheetPlan ? { sheetPlan } : {}),
  };
}
