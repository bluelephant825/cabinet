import { test, expect } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";

import { bootCabinet, type CabinetInstance } from "../test/support/harness";

let cabinet: CabinetInstance;

const SHOTS = process.env.CABINET_E2E_SHOTS ?? "test-results";

async function makePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText("Convert me to a Word document", { x: 60, y: 740, size: 16, font });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

async function putDocument(pathname: string, bytes: Buffer) {
  const qs = new URLSearchParams({ path: pathname });
  return fetch(`${cabinet.appUrl}/api/documents/save?${qs}`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: new Uint8Array(bytes),
  });
}

test.beforeAll(async () => {
  cabinet = await bootCabinet();
  const res = await putDocument("convertme.pdf", await makePdf());
  expect(res.ok, `seed PUT failed: ${res.status} ${await res.text()}`).toBe(true);
});

test.afterAll(async () => {
  await cabinet?.close();
});

test("pdf → convert to Word → opens in the DOCX editor", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("cabinet.dataDirConfirmed", "silent");
    window.localStorage.setItem("cabinet.wizard-done", "1");
    window.localStorage.setItem("cabinet.tour-done", "1");
  });
  await page.goto(`${cabinet.appUrl}/room/convertme.pdf`);
  await page.getByRole("button", { name: "convertme", exact: true }).first().click();

  // Wait for the PDF viewer/editor to mount, then open the convert dialog.
  const pdfFrame = page.frameLocator('iframe[title="Document editor"]');
  await expect(pdfFrame.locator(".pdf-page canvas").first()).toBeVisible({
    timeout: 45_000,
  });
  await page.getByRole("button", { name: "Convert to Word" }).click();

  // Dialog: destination + OCR status, then start the conversion.
  await expect(page.getByText(/convertme\.docx/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Convert", exact: true }).click();

  // Done summary + Open document — interpolated counts, no raw placeholders.
  const summary = page.getByText(/Done —/);
  await expect(summary).toBeVisible({ timeout: 120_000 });
  const summaryText = await summary.textContent();
  expect(summaryText).toMatch(/\d/);
  expect(summaryText).not.toContain("{");
  await page.screenshot({ path: `${SHOTS}/documents-convert-done.png` });
  await page.getByRole("button", { name: "Open document" }).click();

  // The converted DOCX opens in the Step-4 editor and carries the PDF's text.
  const docxFrame = page.frameLocator('iframe[title="Document editor"]');
  await expect(docxFrame.locator(".ProseMirror").first()).toBeVisible({ timeout: 45_000 });
  await expect(docxFrame.locator(".ProseMirror").first()).toContainText(
    "Convert me to a Word document",
    { timeout: 30_000 },
  );
});
