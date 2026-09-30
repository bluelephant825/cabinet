import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as XLSX from "xlsx";

import { runOp } from "../server/documents/worker-ops";
import { DocumentBroker } from "../server/documents/broker";
import { DocumentService } from "../server/documents/service";
import { DocumentError } from "../src/lib/documents/errors";
import { DATA_DIR } from "../src/lib/storage/path-utils";
import { stopXlsxSidecarForTest } from "../server/documents/xlsx-worker";
import { xlsxModelToUniver, xlsxSavePlan } from "../src/components/editor/documents/xlsx-model";
import type { XlsxDocumentModel } from "../src/lib/documents/types";

const dir = path.join(os.tmpdir(), `cabinet-xlsx-${process.pid}`);

test.before(async () => fs.mkdir(dir, { recursive: true }));
test.after(async () => {
  stopXlsxSidecarForTest();
  await fs.rm(dir, { recursive: true, force: true });
});

async function fixture(name = "input.xlsx") {
  const workbook = XLSX.utils.book_new();
  const first = XLSX.utils.aoa_to_sheet([
    ["Name", "Amount", "Double"],
    ["Alpha", 12, { t: "n", f: "B2*2", v: 24 }],
    ["Beta", 7, { t: "n", f: "B3*2", v: 14 }],
  ]);
  const second = XLSX.utils.aoa_to_sheet([["Other sheet"], [true]]);
  XLSX.utils.book_append_sheet(workbook, first, "Budget");
  XLSX.utils.book_append_sheet(workbook, second, "Notes");
  const file = path.join(dir, name);
  await fs.writeFile(file, XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
  return file;
}

test("xlsx worker inspect/read/load expose sheets, values and formulas", async () => {
  const inputPath = await fixture();
  const inspected = (await runOp("inspect", { inputPath, format: "xlsx" })) as {
    format: string;
    sheets: { name: string }[];
  };
  assert.equal(inspected.format, "xlsx");
  assert.deepEqual(inspected.sheets.map((sheet) => sheet.name), ["Budget", "Notes"]);

  const read = (await runOp("read", { inputPath, format: "xlsx" })) as { text: string };
  assert.match(read.text, /## Budget/);
  assert.match(read.text, /Alpha\t12\t=B2\*2/);

  const model = (await runOp("xlsxLoad", { inputPath })) as XlsxDocumentModel;
  assert.equal(model.format, "xlsx");
  assert.equal(model.truncated, false);
  const budget = model.sheets.find((sheet) => sheet.name === "Budget")!;
  assert.equal(budget.cells.find((cell) => cell.row === 1 && cell.column === 0)?.value, "Alpha");
  assert.equal(budget.cells.find((cell) => cell.row === 1 && cell.column === 2)?.formula, "=B2*2");
});

test("xlsx gateway save patches changed cells and preserves untouched sheets/formulas", async () => {
  const inputPath = await fixture("save.xlsx");
  const outputPath = path.join(dir, "saved.xlsx");
  const model = (await runOp("xlsxLoad", { inputPath })) as XlsxDocumentModel;
  const budget = model.sheets.find((sheet) => sheet.name === "Budget")!;
  await runOp("xlsxSave", {
    inputPath,
    outputPath,
    plan: {
      edits: [
        {
          sheetId: budget.id,
          row: 1,
          column: 0,
          writeValue: true,
          value: "Edited",
        },
        {
          sheetId: budget.id,
          row: 3,
          column: 1,
          writeValue: true,
          value: 99,
        },
      ],
    },
  });

  const workbook = XLSX.read(await fs.readFile(outputPath), { type: "buffer", cellFormula: true });
  assert.equal(workbook.Sheets.Budget?.A2?.v, "Edited");
  assert.equal(workbook.Sheets.Budget?.B4?.v, 99);
  assert.equal(workbook.Sheets.Budget?.C2?.f, "B2*2");
  assert.equal(workbook.Sheets.Notes?.A1?.v, "Other sheet");
});

test("xlsx service save advances revisions and rejects an external-edit conflict", async () => {
  const source = await fixture("service-source.xlsx");
  const virtualPath = `xlsx-test-${process.pid}/service.xlsx`;
  const absPath = path.join(DATA_DIR, virtualPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.copyFile(source, absPath);
  const service = new DocumentService(new DocumentBroker({ concurrency: 1 }));
  try {
    const opened = await service.open({ virtualPath });
    assert.equal(opened.format, "xlsx");
    assert.equal(opened.capabilities.edit, true);
    const model = await service.xlsxLoad({ sessionId: opened.sessionId });
    const budget = model.sheets.find((sheet) => sheet.name === "Budget")!;
    const saved = await service.xlsxSave({
      sessionId: opened.sessionId,
      baseRevision: opened.revision,
      plan: {
        edits: [
          { sheetId: budget.id, row: 1, column: 0, writeValue: true, value: "Service edit" },
        ],
      },
    });
    assert.notEqual(saved.revision, opened.revision);
    const recovery = await service.listRecovery(virtualPath);
    assert.ok(recovery.entries.some((entry) => entry.revision === opened.revision));

    const external = await fixture("external.xlsx");
    await fs.copyFile(external, absPath);
    await assert.rejects(
      service.xlsxSave({
        sessionId: opened.sessionId,
        baseRevision: saved.revision,
        plan: {
          edits: [
            { sheetId: budget.id, row: 1, column: 0, writeValue: true, value: "Stale edit" },
          ],
        },
      }),
      (cause) => cause instanceof DocumentError && cause.code === "conflict",
    );
  } finally {
    await service.shutdown();
    await fs.rm(path.dirname(absPath), { recursive: true, force: true });
  }
});

test("Univer snapshot diff emits only changed and cleared cells", async () => {
  const inputPath = await fixture("diff.xlsx");
  const model = (await runOp("xlsxLoad", { inputPath })) as XlsxDocumentModel;
  const snapshot = xlsxModelToUniver(model) as never;
  const budget = model.sheets.find((sheet) => sheet.name === "Budget")!;
  const data = (snapshot as { sheets: Record<string, { cellData: Record<number, Record<number, { v?: unknown }>> }> }).sheets[budget.id]!;
  data.cellData[1]![0]!.v = "Changed";
  delete data.cellData[2]![0];
  (data as { mergeData?: unknown[] }).mergeData = [
    { startRow: 0, endRow: 0, startColumn: 0, endColumn: 1 },
  ];
  const plan = xlsxSavePlan(model, snapshot);
  assert.equal(plan.edits.length, 2);
  assert.ok(plan.edits.some((edit) => edit.row === 1 && edit.column === 0 && edit.value === "Changed"));
  assert.ok(plan.edits.some((edit) => edit.row === 2 && edit.column === 0 && edit.value === null));
  assert.equal(plan.structuralOps?.[0]?.ops[0]?.kind, "merge-cells");
});
