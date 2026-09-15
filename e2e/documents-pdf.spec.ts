import { test, expect, type Page, type FrameLocator } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";

import { bootCabinet, type CabinetInstance } from "../test/support/harness";

let cabinet: CabinetInstance;

/** Screenshot output dir — /tmp keeps the repo clean; overridable via env. */
const SHOTS = process.env.CABINET_E2E_SHOTS ?? "test-results";

/** Simple one-page PDF with two standard-font lines at known positions. */
async function makePdf(line1 = "Hello editable world", line2 = "Second pdf line"): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText(line1, { x: 60, y: 740, size: 16, font });
  page.drawText(line2, { x: 60, y: 700, size: 16, font });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

async function putDocument(pathname: string, bytes: Buffer, baseRevision?: string) {
  const qs = new URLSearchParams({ path: pathname });
  if (baseRevision) qs.set("baseRevision", baseRevision);
  return fetch(`${cabinet.appUrl}/api/documents/save?${qs}`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: new Uint8Array(bytes),
  });
}

async function openPdf(page: Page, pathname: string): Promise<FrameLocator> {
  await page.addInitScript(() => {
    window.localStorage.setItem("cabinet.dataDirConfirmed", "silent");
    window.localStorage.setItem("cabinet.wizard-done", "1");
    window.localStorage.setItem("cabinet.tour-done", "1");
  });
  await page.goto(`${cabinet.appUrl}/room/${pathname}`);
  const stem = pathname.replace(/\.[^.]+$/, "");
  await page.getByRole("button", { name: stem, exact: true }).first().click();
  const frame = page.frameLocator('iframe[title="Document editor"]');
  // `ready` is a bridge message — rendered page canvases are its observable
  // side effect.
  await expect(frame.locator(".pdf-page canvas").first()).toBeVisible({ timeout: 45_000 });
  return frame;
}

/** Click the first text block of page 1 — the fixture draws "Hello…" at
    (60,740) baseline on a 595×842 page; at scale 1.25 that lands near
    css offset (~100, ~110). */
async function clickFirstTextLine(frame: FrameLocator, page: Page) {
  const pageEl = frame.locator(".pdf-page").first();
  const box = await pageEl.boundingBox();
  if (!box) throw new Error("pdf page element has no box");
  await page.mouse.click(box.x + 100, box.y + 110);
}

async function enableEditText(frame: FrameLocator, page: Page) {
  await frame.getByRole("button", { name: "Edit text" }).click();
  // Let the hover layer settle before the click hit-tests a block.
  await page.waitForTimeout(150);
}

test.beforeAll(async () => {
  cabinet = await bootCabinet();
  const res = await putDocument("paper.pdf", await makePdf());
  expect(res.ok, `seed PUT failed: ${res.status} ${await res.text()}`).toBe(true);
});

test.afterAll(async () => {
  await cabinet?.close();
});

test("pdf editor renders pages, edits a text line, saves and persists", async ({
  page,
  request,
}) => {
  const frame = await openPdf(page, "paper.pdf");
  expect(await frame.locator(".pdf-page canvas").count()).toBeGreaterThanOrEqual(1);

  await enableEditText(frame, page);
  await clickFirstTextLine(frame, page);

  // The block draft editor opens over the clicked block.
  const input = frame.locator(".pdf-textedit-input").first();
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill("Hello EDITED world");
  // Commit: click outside the draft (blur commits the block edit).
  await frame.locator(".pdf-frame-toolbar").click();
  await expect(frame.locator(".pdf-textedit-preview").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/documents-pdf-edit.png` });

  await page.keyboard.press(process.platform === "darwin" ? "Meta+s" : "Control+s");
  await expect(page.getByText("Unsaved changes")).toBeHidden({ timeout: 30_000 });

  // The edit must be visible through the inspect API (PDFium text extraction).
  const inspected = await (
    await request.post(`${cabinet.appUrl}/api/documents/inspect`, {
      data: { virtualPath: "paper.pdf" },
    })
  ).json();
  const allText = inspected.pages
    .flatMap((p: { textLines: { text: string }[] }) => p.textLines)
    .map((l: { text: string }) => l.text)
    .join("\n");
  expect(allText).toContain("EDITED");

  // And through the rendered document itself after a reload.
  const frame2 = await openPdf(page, "paper.pdf");
  await expect(frame2.locator(".pdf-page .textLayer").first()).toContainText("EDITED", {
    timeout: 30_000,
  });
});

test("pending edits support undo/redo and clear history on save", async ({ page }) => {
  const res = await putDocument("undo.pdf", await makePdf("Undo base line"));
  expect(res.ok).toBe(true);

  const frame = await openPdf(page, "undo.pdf");
  await enableEditText(frame, page);
  await clickFirstTextLine(frame, page);
  const input = frame.locator(".pdf-textedit-input").first();
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill("Undo EDITED line");
  await frame.locator(".pdf-frame-toolbar").click();
  await expect(frame.locator(".pdf-textedit-preview")).toHaveCount(1);
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  // Undo removes the pending edit and clears the host badge.
  await frame.locator('[data-testid="pdf-tb-undo"]').click();
  await expect(frame.locator(".pdf-textedit-preview")).toHaveCount(0);
  await expect(page.getByText("Unsaved changes")).toBeHidden({ timeout: 10_000 });
  await expect(frame.locator('[data-testid="pdf-tb-undo"]')).toBeDisabled();

  // Redo restores it.
  await frame.locator('[data-testid="pdf-tb-redo"]').click();
  await expect(frame.locator(".pdf-textedit-preview")).toHaveCount(1);
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  // Save bakes the edit — history is for unsaved edits only.
  await page.keyboard.press(process.platform === "darwin" ? "Meta+s" : "Control+s");
  await expect(page.getByText("Unsaved changes")).toBeHidden({ timeout: 30_000 });
  await expect(frame.locator('[data-testid="pdf-tb-undo"]')).toBeDisabled();
});

test("external edit while dirty shows a conflict banner without reloading", async ({
  page,
  request,
}) => {
  const res = await putDocument("conflict.pdf", await makePdf("Conflict base"));
  expect(res.ok).toBe(true);

  const frame = await openPdf(page, "conflict.pdf");
  await enableEditText(frame, page);
  await clickFirstTextLine(frame, page);
  const input = frame.locator(".pdf-textedit-input").first();
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill("Local edit");
  await frame.locator(".pdf-frame-toolbar").click();
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  // Modify the same file underneath the open session.
  const rev = await (
    await request.get(`${cabinet.appUrl}/api/documents/revision?path=conflict.pdf`)
  ).json();
  const overwrite = await putDocument(
    "conflict.pdf",
    await makePdf("Conflict base externally changed"),
    rev.revision,
  );
  expect(overwrite.ok).toBe(true);

  await expect(frame.locator(".doc-conflict-banner")).toBeVisible({ timeout: 15_000 });
  // The pending edit preview must survive — no silent reload.
  await expect(frame.locator(".pdf-textedit-preview").first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/documents-pdf-conflict.png` });
});

test("pdf draft format bar restyles an edit and an insert end to end", async ({
  page,
  request,
}) => {
  const res = await putDocument("styled.pdf", await makePdf("Styled base line"));
  expect(res.ok).toBe(true);

  const frame = await openPdf(page, "styled.pdf");
  await enableEditText(frame, page);
  await clickFirstTextLine(frame, page);

  const input = frame.locator(".pdf-textedit-input").first();
  await expect(input).toBeVisible({ timeout: 10_000 });

  // The format bar floats with the draft; interact with it without blur-committing.
  const bar = frame.locator('[data-testid="pdf-draft-format"]');
  await expect(bar).toBeVisible();
  // The font select lists curated ids plus the installed-families optgroup —
  // fonts/list resolves asynchronously, so wait for the group to appear.
  await expect(
    bar.locator('[data-testid="pdf-draft-font"] optgroup[label="Installed fonts"]'),
  ).toBeAttached();
  expect(
    await bar.locator('[data-testid="pdf-draft-font"] option').count(),
  ).toBeGreaterThan(3);
  // Smaller than the block's 16pt — a grown size would hit the overflow guard.
  await bar.locator('[data-testid="pdf-draft-size"]').fill("12");
  await bar.locator('[data-testid="pdf-draft-color"]').fill("#ff0000");
  await bar.locator('[data-testid="pdf-draft-bold"]').click();
  await bar.locator('[data-testid="pdf-draft-done"]').click();

  // Committed to a pending edit — the draft is gone, a preview chip appears.
  await expect(frame.locator(".pdf-textedit-preview").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  // Intercept the patch request — the op must carry the style overrides.
  const saveReq = page.waitForRequest(
    (r) => r.url().includes("/api/documents/patch") && r.method() === "POST",
  );
  await page.keyboard.press(process.platform === "darwin" ? "Meta+s" : "Control+s");
  const patchBody = (await saveReq).postDataJSON() as {
    ops: { kind: string; edit?: Record<string, unknown> }[];
  };
  await expect(page.getByText("Unsaved changes")).toBeHidden({ timeout: 30_000 });
  const edit = patchBody.ops.find((o) => o.kind === "pdfTextEdit")?.edit;
  expect(edit).toBeTruthy();
  expect(edit!.newFontSize).toBe(12);
  expect(edit!.newColor).toEqual([255, 0, 0]);
  expect(edit!.newBold).toBe(true);

  // The styled text is still in the saved file.
  const inspected = await (
    await request.post(`${cabinet.appUrl}/api/documents/inspect`, {
      data: { virtualPath: "styled.pdf" },
    })
  ).json();
  const allText = inspected.pages
    .flatMap((p: { textLines: { text: string }[] }) => p.textLines)
    .map((l: { text: string }) => l.text)
    .join("\n");
  expect(allText).toContain("Styled base line");

  // Insert flow: type on empty page space, style via the bar, save.
  const res2 = await putDocument("inserted.pdf", await makePdf("Insert base"));
  expect(res2.ok).toBe(true);
  const frame2 = await openPdf(page, "inserted.pdf");
  await frame2.getByRole("button", { name: "Insert text" }).click();
  await page.waitForTimeout(150);
  const pageEl = frame2.locator(".pdf-page").first();
  const box = await pageEl.boundingBox();
  if (!box) throw new Error("pdf page element has no box");
  await page.mouse.click(box.x + 300, box.y + 500);

  const ins = frame2.locator(".pdf-insert-draft-wrap textarea");
  await expect(ins).toBeVisible({ timeout: 10_000 });
  await ins.fill("Inserted styled text");
  const bar2 = frame2.locator('[data-testid="pdf-draft-format"]');
  await bar2.locator('[data-testid="pdf-draft-size"]').fill("20");
  await bar2.locator('[data-testid="pdf-draft-color"]').fill("#0000ff");
  await bar2.locator('[data-testid="pdf-draft-done"]').click();
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  const saveReq2 = page.waitForRequest(
    (r) => r.url().includes("/api/documents/patch") && r.method() === "POST",
  );
  await page.keyboard.press(process.platform === "darwin" ? "Meta+s" : "Control+s");
  const patchBody2 = (await saveReq2).postDataJSON() as {
    ops: { kind: string; insert?: Record<string, unknown> }[];
  };
  await expect(page.getByText("Unsaved changes")).toBeHidden({ timeout: 30_000 });
  const insert = patchBody2.ops.find((o) => o.kind === "pdfTextInsert")?.insert;
  expect(insert).toBeTruthy();
  expect(insert!.fontSize).toBe(20);
  expect(insert!.color).toEqual([0, 0, 255]);
});

test("unmatchable pending edit surfaces diagnostics and keeps edits pending", async ({
  page,
  request,
}) => {
  const res = await putDocument("invalid.pdf", await makePdf("Matchable text"));
  expect(res.ok).toBe(true);

  const frame = await openPdf(page, "invalid.pdf");
  const revBefore = await (
    await request.get(`${cabinet.appUrl}/api/documents/revision?path=invalid.pdf`)
  ).json();

  // Inject a pending edit whose oldText matches nothing in the file — the
  // equivalent of a stale edit the engine must skip.
  const editorFrame = page
    .frames()
    .find((f) => f.url().includes("document-editor"));
  expect(editorFrame).toBeTruthy();
  await editorFrame!.evaluate(() => {
    (
      window as unknown as {
        __cabinetPdf: { injectEdit: (e: Record<string, unknown>) => void };
      }
    ).__cabinetPdf.injectEdit({
      pageIndex: 0,
      rect: [50, 700, 250, 720],
      oldText: "This text does not exist anywhere",
      newText: "Ghost replacement",
      fontSize: 12,
    });
  });
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  await page.keyboard.press(process.platform === "darwin" ? "Meta+s" : "Control+s");

  // The rejected op surfaces as diagnostics — not a silent partial apply.
  await expect(frame.locator(".pdf-diag-banner")).toBeVisible({ timeout: 15_000 });

  // File and revision are unchanged by the rejected save.
  const revAfter = await (
    await request.get(`${cabinet.appUrl}/api/documents/revision?path=invalid.pdf`)
  ).json();
  expect(revAfter.revision).toBe(revBefore.revision);

  // Pending edits are kept, not dropped.
  await expect(frame.locator(".pdf-textedit-preview").first()).toBeVisible();
});
