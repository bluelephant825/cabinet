import { test, expect, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";

import { bootCabinet, type CabinetInstance } from "../test/support/harness";
import { buildBlankDocx } from "../src/vendor/genoffice/packages/docx-engine/src/blank";
import {
  parseDocx,
  saveDocx,
} from "../src/vendor/genoffice/packages/docx-engine/src/index";

let cabinet: CabinetInstance;

const SHOTS = process.env.CABINET_E2E_SHOTS ?? "test-results";

async function makePdf(text: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText(text, { x: 60, y: 740, size: 16, font });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

async function makeDocx(text: string): Promise<Buffer> {
  const blank = await buildBlankDocx();
  const doc = await parseDocx(blank);
  const bytes = await saveDocx(doc, [
    { kind: "generated", block: { type: "paragraph", runs: [{ text }] } },
  ]);
  return Buffer.from(bytes);
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
  for (const [name, bytes] of [
    ["convertme.pdf", await makePdf("Convert me to a Word document")],
    ["markpdf.pdf", await makePdf("Convert me to a Markdown page")],
    ["markdoc.docx", await makeDocx("Docx to markdown body")],
  ] as const) {
    const res = await putDocument(name, bytes);
    expect(res.ok, `seed PUT ${name} failed: ${res.status} ${await res.text()}`).toBe(true);
  }
});

test.afterAll(async () => {
  await cabinet?.close();
});

async function openDocument(page: Page, name: string) {
  await page.addInitScript(() => {
    window.localStorage.setItem("cabinet.dataDirConfirmed", "silent");
    window.localStorage.setItem("cabinet.wizard-done", "1");
    window.localStorage.setItem("cabinet.tour-done", "1");
  });
  await page.goto(`${cabinet.appUrl}/room/${name}`);
  await page.getByRole("button", { name: name.replace(/\.[^.]+$/, ""), exact: true }).first().click();
}

test("pdf → convert to Word → opens in the DOCX editor", async ({ page }) => {
  await openDocument(page, "convertme.pdf");

  // Wait for the PDF viewer/editor to mount, then open the convert dialog.
  const pdfFrame = page.frameLocator('iframe[title="Document editor"]');
  await expect(pdfFrame.locator(".pdf-page canvas").first()).toBeVisible({
    timeout: 45_000,
  });
  await page.getByRole("button", { name: "Convert", exact: true }).click();
  await page.getByRole("menuitem", { name: "Convert to Word" }).click();

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

test("pdf → convert to Markdown → opens in the Markdown editor", async ({ page }) => {
  await openDocument(page, "markpdf.pdf");

  const pdfFrame = page.frameLocator('iframe[title="Document editor"]');
  await expect(pdfFrame.locator(".pdf-page canvas").first()).toBeVisible({
    timeout: 45_000,
  });
  await page.getByRole("button", { name: "Convert", exact: true }).click();
  await page.getByRole("menuitem", { name: "Convert to Markdown" }).click();

  // Markdown is the default target; the plan shows the .md destination.
  await expect(page.getByText(/markpdf\.md/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Convert", exact: true }).click();

  await expect(page.getByText(/file\(s\) created/)).toBeVisible({ timeout: 120_000 });
  await page.screenshot({ path: `${SHOTS}/documents-convert-md-done.png` });
  await page.getByRole("button", { name: "Open document" }).click();

  // The generated page opens in the Markdown editor with the extracted text.
  await expect(page.locator(".ProseMirror").first()).toContainText(
    "Convert me to a Markdown page",
    { timeout: 45_000 },
  );
});

test("docx → convert to Markdown → opens in the Markdown editor", async ({ page }) => {
  await openDocument(page, "markdoc.docx");

  // Wait for the DOCX editor (or its fallback) to mount before converting.
  const docxFrame = page.frameLocator('iframe[title="Document editor"]');
  await expect(docxFrame.locator(".ProseMirror").first()).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "Convert", exact: true }).click();
  await page.getByRole("menuitem", { name: "Convert to Markdown" }).click();

  await expect(page.getByText(/markdoc\.md/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Convert", exact: true }).click();

  await expect(page.getByText(/file\(s\) created/)).toBeVisible({ timeout: 120_000 });
  await page.getByRole("button", { name: "Open document" }).click();

  await expect(page.locator(".ProseMirror").first()).toContainText(
    "Docx to markdown body",
    { timeout: 45_000 },
  );
});
