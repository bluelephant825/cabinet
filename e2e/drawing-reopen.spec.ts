import { test, expect, type Page } from "@playwright/test";

import { bootCabinet, type CabinetInstance } from "../test/support/harness";

let cabinet: CabinetInstance;

const EXCALIDRAW_TITLE = "excalidraw-reopen";
const EXCALIDRAW_FILE = `${EXCALIDRAW_TITLE}.excalidraw.svg`;
const DRAWIO_TITLE = "drawio-reopen";
const DRAWIO_FILE = `${DRAWIO_TITLE}.drawio`;

async function openDrawingEditor(
  page: Page,
  treeTitle: string,
  iframeSource: string,
) {
  await page.addInitScript(() => {
    window.localStorage.setItem("cabinet.dataDirConfirmed", "silent");
    window.localStorage.setItem("cabinet.wizard-done", "1");
    window.localStorage.setItem("cabinet.tour-done", "1");
  });
  await page.goto(`${cabinet.appUrl}/room/Diagrams`);

  const expand = page.getByRole("button", { name: "Expand Diagrams", exact: true });
  if (await expand.count()) await expand.click();
  const file = page.getByRole("complementary").getByRole("button", {
    name: treeTitle,
    exact: true,
  });
  await expect(file).toBeVisible({ timeout: 30_000 });
  await file.click();

  const iframe = page.locator(`iframe[src*="${iframeSource}"]`);
  await expect(iframe).toBeVisible({ timeout: 30_000 });
  return iframe;
}

async function simulateSave(page: Page, type: "excalidraw-saved" | "drawio-saved") {
  await page.evaluate((eventType) => {
    window.postMessage({ type: eventType }, "*");
  }, type);
}

test.beforeAll(async () => {
  cabinet = await bootCabinet({
    files: {
      ".home/home.json": JSON.stringify({
        schemaVersion: 1,
        kind: "home",
        activeCabinet: "Cabinet",
      }),
      "Cabinet/.cabinet": JSON.stringify({
        schemaVersion: 1,
        kind: "root",
        name: "Drawing test",
        entry: "index.md",
      }),
      "Cabinet/.agents/.config/workspace.json": JSON.stringify({
        exists: true,
        version: 2,
        home: { name: "Test" },
        cabinet: { name: "Test" },
      }),
      "Cabinet/index.md": "# Drawing test\n",
      [`Cabinet/Diagrams/${EXCALIDRAW_FILE}`]:
        '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
      [`Cabinet/Diagrams/${DRAWIO_FILE}`]:
        '<mxfile host="app.diagrams.net"><diagram id="test" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>',
    },
  });
});

test.afterAll(async () => {
  await cabinet?.close();
});

test("an Excalidraw drawing can be reopened after the editor save message", async ({ page }) => {
  const source = "/excalidraw/editor?path=";
  const iframe = await openDrawingEditor(page, EXCALIDRAW_TITLE, source);

  await simulateSave(page, "excalidraw-saved");
  await expect(iframe).toBeHidden();

  await page.getByRole("complementary").getByRole("button", {
    name: EXCALIDRAW_TITLE,
    exact: true,
  }).click();
  await expect(page.locator(`iframe[src*="${source}"]`)).toBeVisible({ timeout: 30_000 });
});

test("a Draw.io diagram can be reopened after the editor save message", async ({ page }) => {
  const source = "/drawio/editor.html?path=";
  const iframe = await openDrawingEditor(page, DRAWIO_TITLE, source);

  await simulateSave(page, "drawio-saved");
  await expect(iframe).toBeHidden();

  await page.getByRole("complementary").getByRole("button", {
    name: DRAWIO_TITLE,
    exact: true,
  }).click();
  await expect(page.locator(`iframe[src*="${source}"]`)).toBeVisible({ timeout: 30_000 });
});
