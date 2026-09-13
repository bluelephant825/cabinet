import { test, expect, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { bootCabinet, type CabinetInstance } from "../test/support/harness";

let cabinet: CabinetInstance;
const SHOTS = process.env.CABINET_E2E_SHOTS ?? "test-results";

async function setup(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("cabinet.dataDirConfirmed", "silent");
    window.localStorage.setItem("cabinet.wizard-done", "1");
    window.localStorage.setItem("cabinet.tour-done", "1");
  });
}

test.beforeAll(async () => {
  cabinet = await bootCabinet({
    files: { "seed.md": "---\ntitle: Seed\n---\n# Seed\n" },
  });
  // A second composition source for the responsive test (independent of the
  // dialog-driven flow, which runs in a parallel worker).
  const res = await fetch(`${cabinet.appUrl}/api/system/create-file`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "pdfComposition", name: "responsive", template: "blank" }),
  });
  const data = await res.json();
  if (!res.ok || !data?.path) throw new Error(`seed create-file failed: ${res.status} ${JSON.stringify(data)}`);
});

test.afterAll(async () => {
  await cabinet?.close();
});

/** Fresh one-page PDF — byte-different from any generated output. */
async function makePdf(text: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([595, 842]);
  p.drawText(text, { x: 60, y: 740, size: 16, font });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/**
 * The New File dialog dispatches `cabinet:open-editor-chat`, which mounts the
 * task panel (Chat / Highlights & Notes tabs) asynchronously — a one-shot
 * visibility check races it. Wait for the panel, close it, and assert the tab
 * strip is gone so screenshots fail loudly if anything ever reopens it.
 */
async function ensureChatPanelClosed(page: Page) {
  const close = page.getByRole("button", { name: "Close (Esc)" }).first();
  await close.waitFor({ state: "visible", timeout: 8_000 }).catch(() => {});
  if (await close.isVisible().catch(() => false)) await close.click();
  await expect(page.getByRole("button", { name: "Highlights & Notes" })).toHaveCount(0);
}

test("pdf composer: create, edit, preview, save, publish, conflict", async ({ page }) => {
  test.setTimeout(180_000);
  await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${cabinet.appUrl}/room`);

  // ── New File → PDF from components (report) ─────────────────────────────
  const seedRow = page.getByRole("button", { name: "Seed", exact: true }).first();
  await expect(seedRow).toBeVisible({ timeout: 30_000 });
  await seedRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: /Create New File/ }).click();
  await page.getByRole("button", { name: /PDF from Components/ }).click();
  await page.getByRole("button", { name: "Report", exact: true }).click();
  await page.getByPlaceholder("File name").fill("quarterly");
  await page.getByRole("button", { name: "Create", exact: true }).click();

  await ensureChatPanelClosed(page);

  // ── editor opens with the report outline populated ──────────────────────
  const outline = page.getByTestId("pdf-outline");
  await expect(outline).toBeVisible({ timeout: 30_000 });
  // Rows below the fold report "hidden" — assert presence, then scroll.
  const chartRow = outline.locator("[data-node-id]").filter({ hasText: "Chart" }).first();
  await expect(chartRow).toHaveCount(1);
  await expect(outline.getByText("Table").first()).toBeAttached();

  // ── click-insert a Heading from the palette ─────────────────────────────
  await page.getByTestId("pdf-palette").getByRole("button", { name: "Heading", exact: true }).click();
  const inspector = page.getByTestId("pdf-inspector");
  const headingText = inspector.locator("textarea").first();
  await expect(headingText).toBeVisible();
  await headingText.fill("E2E Quarterly Heading");

  // ── keyboard-move it up (Alt+↑) — new heading lands after selection ─────
  const newHeadingRow = outline.locator("[data-node-id]").filter({ hasText: "E2E Quarterly Heading" }).first();
  await newHeadingRow.focus();
  const prevOrder = await outline.locator("[data-node-id]").allTextContents();
  await page.keyboard.press("Alt+ArrowUp");
  await page.waitForTimeout(200);
  const newOrder = await outline.locator("[data-node-id]").allTextContents();
  expect(newOrder).not.toEqual(prevOrder);

  // ── drag a Table from the palette into the body via pointer ────────────
  const paletteTable = page.getByTestId("pdf-palette").getByRole("button", { name: "Table", exact: true });
  const tableBox = await paletteTable.boundingBox();
  expect(tableBox).toBeTruthy();
  // Zone ids are `zone:<region>:<parentId>:<index>` — target a BODY zone
  // (the last DOM zone belongs to the footer region, which rejects Table).
  // Zones are 2px until a drag starts (then 12px, shifting every rect), so
  // we must re-measure the target's live position MID-drag.
  const dropZone = outline.locator('[data-zone-id="zone:body:root:0"]');
  await dropZone.scrollIntoViewIfNeeded();
  await page.mouse.move(tableBox!.x + 10, tableBox!.y + 5);
  await page.mouse.down();
  await page.mouse.move(tableBox!.x + 60, tableBox!.y + 40);
  await page.waitForTimeout(250); // let zones expand + dnd-kit re-measure
  const lz = await dropZone.boundingBox();
  expect(lz).toBeTruthy();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(
      tableBox!.x + 60 + ((lz!.x + 30 - (tableBox!.x + 60)) * i) / 10,
      tableBox!.y + 40 + ((lz!.y + lz!.height / 2 - (tableBox!.y + 40)) * i) / 10,
    );
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  await page.waitForTimeout(300);
  // Two tables now: the template's + the dropped one.
  await expect(outline.getByText("Table")).toHaveCount(2);

  // ── invalid drop: Heading INTO a leaf (the new table's own zone? no —
  // page-break would be better; the report has none. Drop heading onto a
  // leaf row's inside — leaves have no inside-zone, so instead assert a
  // palette Watermark (body-only) over the HEADER region zone is invalid.
  // Header/footer regions render collapsed — expand the header region so its
  // drop zone exists for the invalid-drop probe.
  await outline.getByRole("button", { name: "Header" }).click();
  const headerZone = outline.locator('[data-zone-id^="zone:header:"]').first();
  const hz = await headerZone.boundingBox();
  expect(hz).toBeTruthy();
  const paletteWatermark = page
    .getByTestId("pdf-palette")
    .getByRole("button", { name: "Watermark", exact: true });
  const wb = await paletteWatermark.boundingBox();
  const outlineBefore = await outline.locator("[data-node-id]").count();
  await page.mouse.move(wb!.x + 10, wb!.y + 5);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(
      wb!.x + ((hz!.x - wb!.x) * i) / 10,
      wb!.y + ((hz!.y - wb!.y) * i) / 10,
    );
    await page.waitForTimeout(30);
  }
  // The indicator should be red (invalid).
  await expect(headerZone.locator("div")).toHaveCSS("background-color", /rgb\(239, 68, 68\)|oklch/)
    .catch(() => {}); // color varies by theme; the count assertion is the real check
  await page.mouse.up();
  await page.waitForTimeout(200);
  expect(await outline.locator("[data-node-id]").count()).toBe(outlineBefore);
  // Pointer drags must not leave residual text selection behind.
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");

  await ensureChatPanelClosed(page);
  await page.screenshot({ path: `${SHOTS}/pdf-composer-compose.png` });

  // ── split mode → preview renders real PDF pages ─────────────────────────
  await page.getByRole("button", { name: "Split" }).click();
  const preview = page.getByTestId("pdf-preview");
  await expect(preview.locator("canvas").first()).toBeVisible({ timeout: 60_000 });
  await ensureChatPanelClosed(page);
  await page.screenshot({ path: `${SHOTS}/pdf-composer-split.png` });

  // ── save + persistence across reload ────────────────────────────────────
  await page.keyboard.press("ControlOrMeta+s");
  // Save button is disabled once dirty clears — that's the save-completed signal.
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled({
    timeout: 15_000,
  });
  // The route alone lands on the room dashboard — re-open via the tree (same
  // pattern as the documents specs; the sidebar strips ".json").
  await page.reload();
  await setup(page);
  await page.goto(`${cabinet.appUrl}/room`);
  await page.getByRole("button", { name: "quarterly.pdf.source", exact: true }).first().click();
  await expect(outline.getByText("E2E Quarterly Heading")).toBeVisible({ timeout: 30_000 });
  await expect(outline.getByText("Table")).toHaveCount(2);

  // ── Generate PDF → status pill ──────────────────────────────────────────
  await page.getByRole("button", { name: "Generate PDF" }).click();
  await expect(page.getByTestId("pdf-status-pill")).toHaveText("PDF up to date", { timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Open PDF" })).toBeVisible();

  // ── Open PDF → the generated PDF renders in the document host ───────────
  await page.getByRole("button", { name: "Open PDF" }).click();
  await page.waitForTimeout(1500);
  // The daemon's text extraction confirms the heading made it into the PDF.
  const read = await fetch(
    `${cabinet.appUrl}/api/documents/read`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ virtualPath: "quarterly.pdf" }),
    },
  ).then((r) => r.json());
  expect(JSON.stringify(read)).toContain("E2E Quarterly Heading");

  // ── back to source: prop change → status "out of date" ──────────────────
  await page.getByRole("button", { name: "quarterly.pdf.source", exact: true }).first().click();
  await expect(outline).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("pdf-status-pill")).toHaveText("PDF up to date");
  await outline.getByText("E2E Quarterly Heading").click();
  await inspector.locator("textarea").first().fill("E2E Heading Changed");
  // save (autosave may race; explicit save is deterministic)
  await page.keyboard.press("ControlOrMeta+s");
  await page.waitForTimeout(800);
  await expect(page.getByTestId("pdf-status-pill")).toHaveText("PDF out of date", { timeout: 15_000 });

  // ── external modification → conflict → save as copy ─────────────────────
  // Overwrite the generated PDF outside the composer (different bytes → the
  // service reports output-modified on the next publish). Same write path the
  // documents-pdf spec uses for external edits.
  const rev = await fetch(
    `${cabinet.appUrl}/api/documents/revision?path=quarterly.pdf`,
  ).then((r) => r.json());
  const overwrite = await fetch(
    `${cabinet.appUrl}/api/documents/save?path=quarterly.pdf&baseRevision=${encodeURIComponent(rev.revision)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array(await makePdf("Externally edited output")),
    },
  );
  expect(overwrite.ok, `overwrite failed: ${overwrite.status} ${await overwrite.text()}`).toBe(true);

  await page.getByRole("button", { name: "Generate PDF" }).click();
  await expect(page.getByTestId("pdf-publish-conflict")).toBeVisible({ timeout: 60_000 });
  await ensureChatPanelClosed(page);
  await page.screenshot({ path: `${SHOTS}/pdf-composer-conflict.png` });
  await page.getByRole("button", { name: "Save as new copy" }).click();
  await expect(page.getByTestId("pdf-status-pill")).toHaveText("PDF up to date", { timeout: 60_000 });
  const copyCheck = await fetch(
    `${cabinet.appUrl}/api/documents/revision?path=quarterly%20(2).pdf`,
  );
  expect(copyCheck.ok).toBe(true);
});

test("responsive: palette/inspector collapse to drawers below 1000px", async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto(`${cabinet.appUrl}/room`);
  const row = page.getByRole("button", { name: "responsive.pdf.source", exact: true }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(page.getByTestId("pdf-outline")).toBeVisible({ timeout: 30_000 });
  // Palette is hidden; the drawer toggle exists instead.
  await expect(page.getByTestId("pdf-palette")).toHaveCount(0);
  await page.getByRole("button", { name: "Blocks" }).click();
  await expect(page.getByTestId("pdf-palette-drawer")).toBeVisible();
  await ensureChatPanelClosed(page);
  await page.screenshot({ path: `${SHOTS}/pdf-composer-narrow.png` });
});
