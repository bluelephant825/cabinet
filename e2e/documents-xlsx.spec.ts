import { test, expect, type Page } from "@playwright/test";
import * as XLSX from "xlsx";

import { bootCabinet, type CabinetInstance } from "../test/support/harness";

let cabinet: CabinetInstance;

function workbookBytes(): Buffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["Name", "Amount"],
      ["Alpha", 12],
      ["Beta", 7],
    ]),
    "Budget",
  );
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Notes"]]), "Notes");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

async function putDocument(path: string, bytes: Buffer) {
  const response = await fetch(
    `${cabinet.appUrl}/api/documents/save?${new URLSearchParams({ path })}`,
    {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array(bytes),
    },
  );
  expect(response.ok, `seed PUT failed: ${response.status} ${await response.text()}`).toBe(true);
}

async function openXlsx(page: Page, path: string) {
  await page.addInitScript(() => {
    localStorage.setItem("cabinet.dataDirConfirmed", "silent");
    localStorage.setItem("cabinet.wizard-done", "1");
    localStorage.setItem("cabinet.tour-done", "1");
  });
  await page.goto(`${cabinet.appUrl}/room/${path}`);
  await page.getByRole("button", { name: path.replace(/\.xlsx$/, ""), exact: true }).first().click();
  const frame = page.frameLocator('iframe[title="Document editor"]');
  await expect(frame.locator("html[data-xlsx-ready=true]")).toHaveCount(1, { timeout: 30_000 });
  return frame;
}

test.beforeAll(async () => {
  cabinet = await bootCabinet();
});

test.afterAll(async () => {
  await cabinet?.close();
});

test("xlsx editor opens a real workbook, edits a cell, saves and persists", async ({ page }) => {
  await putDocument("budget.xlsx", workbookBytes());
  const frame = await openXlsx(page, "budget.xlsx");
  await expect(frame.locator('canvas[id^="univer-sheet-main-canvas"]')).toBeVisible();
  const grid = frame.locator('canvas[id^="univer-sheet-main-canvas"]');
  const box = await grid.boundingBox();
  expect(box).not.toBeNull();
  await grid.click({ position: { x: 95, y: 67 } });
  await page.keyboard.type("Edited");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await expect(page.getByText("Unsaved changes")).toBeHidden({ timeout: 15_000 });

  const frame2 = await openXlsx(page, "budget.xlsx");
  await expect(frame2.locator('canvas[id^="univer-sheet-main-canvas"]')).toBeVisible();
  const read = await fetch(`${cabinet.appUrl}/api/documents/read`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ virtualPath: "budget.xlsx" }),
  });
  expect(read.ok).toBe(true);
  expect((await read.json()).text).toContain("Edited");
});
