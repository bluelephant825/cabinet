import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

import { bootCabinet, type CabinetInstance } from "../test/support/harness";
import {
  addElement,
  createBlankPptx,
  openPptx,
  savePptx,
  setSlideNotes,
} from "../src/vendor/genoffice/packages/pptx-engine/src/index";

let cabinet: CabinetInstance;

async function presentationBytes(title = "Original slide title"): Promise<Buffer> {
  const opened = await openPptx(await createBlankPptx());
  addElement(opened.deck.slides[0]!, {
    kind: "textbox",
    offset: { x: 914400, y: 914400, cx: 5486400, cy: 914400 },
    paragraphs: [{ runs: [{ text: title, bold: true }] }],
  });
  setSlideNotes(opened, 0, "Original speaker note");
  return Buffer.from(await savePptx(opened));
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

async function openPptxEditor(page: Page, path: string) {
  await page.addInitScript(() => {
    localStorage.setItem("cabinet.dataDirConfirmed", "silent");
    localStorage.setItem("cabinet.wizard-done", "1");
    localStorage.setItem("cabinet.tour-done", "1");
  });
  await page.goto(`${cabinet.appUrl}/room/${path}`);
  await page.getByRole("button", { name: path.replace(/\.pptx$/, ""), exact: true }).first().click();
  const frame = page.frameLocator('iframe[title="Document editor"]');
  await expect(frame.locator("html[data-pptx-ready=true]")).toHaveCount(1, { timeout: 30_000 });
  return frame;
}

test.beforeAll(async () => {
  cabinet = await bootCabinet();
});

test.afterAll(async () => {
  await cabinet?.close();
});

test("pptx editor changes slide text and speaker notes and persists both", async ({ page }) => {
  await putDocument("presentation.pptx", await presentationBytes());
  const frame = await openPptxEditor(page, "presentation.pptx");
  await expect(frame.locator("[data-pptx-preview]")).toBeVisible();
  const text = frame.getByLabel(/Slide 1 .* run 1/).first();
  await text.fill("Edited slide title");
  await frame.getByLabel("Slide 1 speaker notes").fill("Edited speaker note");
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await expect(page.getByText("Unsaved changes")).toBeHidden({ timeout: 15_000 });

  const read = await fetch(`${cabinet.appUrl}/api/documents/read`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ virtualPath: "presentation.pptx" }),
  });
  expect(read.ok).toBe(true);
  const body = (await read.json()) as { text: string };
  expect(body.text).toContain("Edited slide title");
  expect(body.text).toContain("Edited speaker note");
});

test("direct GenOffice-style write is detected by revision polling while local edits stay dirty", async ({ page }) => {
  await putDocument("presentation-conflict.pptx", await presentationBytes("Conflict base"));
  const frame = await openPptxEditor(page, "presentation-conflict.pptx");
  const text = frame.getByLabel(/Slide 1 .* run 1/).first();
  await text.fill("Unsaved local title");
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  await fs.writeFile(
    path.join(cabinet.dataDir, "presentation-conflict.pptx"),
    await presentationBytes("External GenOffice title"),
  );

  await expect(page.getByText("Document changed on disk")).toBeVisible({ timeout: 15_000 });
  await expect(text).toHaveValue("Unsaved local title");
});
