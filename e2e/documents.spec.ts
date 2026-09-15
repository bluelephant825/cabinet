import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

import { bootCabinet, type CabinetInstance } from "../test/support/harness";
import {
  buildBlankDocx,
  parseDocx,
  saveDocx,
  type SaveBlock,
} from "../src/vendor/genoffice/packages/docx-engine/src/index";

let cabinet: CabinetInstance;

/** Screenshot output dir — /tmp keeps the repo clean; overridable via env. */
const SHOTS = process.env.CABINET_E2E_SHOTS ?? "test-results";

const para = (text: string): SaveBlock => ({
  kind: "generated",
  block: { type: "paragraph", runs: [{ text }] },
});

/** Minimal DOCX produced by the vendored engine itself. */
async function makeDocx(...texts: string[]): Promise<Buffer> {
  const blank = await buildBlankDocx();
  const doc = await parseDocx(blank);
  return Buffer.from(await saveDocx(doc, texts.map(para)));
}

async function putDocument(pathname: string, bytes: Buffer, baseRevision?: string) {
  const qs = new URLSearchParams({ path: pathname });
  if (baseRevision) qs.set("baseRevision", baseRevision);
  const res = await fetch(`${cabinet.appUrl}/api/documents/save?${qs}`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: new Uint8Array(bytes),
  });
  return res;
}

async function openDocx(page: Page, pathname: string) {
  // Mark the first-run data-dir picker + onboarding wizard as done so the
  // shell renders the file tree instead of the setup screens.
  await page.addInitScript(() => {
    window.localStorage.setItem("cabinet.dataDirConfirmed", "silent");
    window.localStorage.setItem("cabinet.wizard-done", "1");
    window.localStorage.setItem("cabinet.tour-done", "1");
  });
  await page.goto(`${cabinet.appUrl}/room/${pathname}`);
  // Select the file in the sidebar tree — the route alone lands on the room
  // dashboard.
  const stem = pathname.replace(/\.[^.]+$/, "");
  await page.getByRole("button", { name: stem, exact: true }).first().click();
  const frame = page.frameLocator('iframe[title="Document editor"]');
  // `ready` is a bridge message — the ProseMirror root appearing is its
  // observable side effect.
  const editor = frame.locator(".ProseMirror").first();
  await expect(editor).toBeVisible({ timeout: 30_000 });
  return frame;
}

test.beforeAll(async () => {
  cabinet = await bootCabinet();
  // Seed the DOCX through the real write path — same route the editor saves to.
  const res = await putDocument("notes.docx", await makeDocx("First paragraph"));
  expect(res.ok, `seed PUT failed: ${res.status} ${await res.text()}`).toBe(true);
});

test.afterAll(async () => {
  await cabinet?.close();
});

test("docx editor opens, edits, saves and persists across reload", async ({ page }) => {
  const frame = await openDocx(page, "notes.docx");
  const editor = frame.locator(".ProseMirror").first();

  // Type into the first paragraph → dirty badge appears.
  await editor.locator("p").first().click();
  await page.keyboard.type(" typed-by-e2e");
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/documents-dirty.png` });

  await page.keyboard.press(process.platform === "darwin" ? "Meta+s" : "Control+s");
  await expect(page.getByText("Unsaved changes")).toBeHidden({ timeout: 15_000 });

  // Reload and confirm the text made it to disk.
  const frame2 = await openDocx(page, "notes.docx");
  await expect(frame2.locator(".ProseMirror").first()).toContainText("typed-by-e2e", {
    timeout: 30_000,
  });
});

test("docx toolbar formats text and lists; save persists across reload", async ({ page }) => {
  // Fixture has no lists — the bullet toggle exercises the pending
  // numbering.xml newDefs path end to end.
  const res = await putDocument("toolbar.docx", await makeDocx("Toolbar target"));
  expect(res.ok).toBe(true);

  const frame = await openDocx(page, "toolbar.docx");
  const editor = frame.locator(".ProseMirror").first();
  await expect(frame.locator('[data-testid="docx-toolbar"]')).toBeVisible();

  // Select the paragraph text, bold it, then bullet it.
  await editor.locator("p").first().click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
  await frame.locator('[data-testid="docx-tb-bold"]').click();
  await expect(editor.locator("strong").first()).toBeVisible();

  await frame.locator('[data-testid="docx-tb-bullets"]').click();
  await expect(editor.locator(".doc-li").first()).toBeVisible();

  // The font select lists the curated entries plus the daemon's installed
  // families in an "Installed fonts" group.
  const fontSelect = frame.locator('[data-testid="docx-tb-font"]');
  const installedGroup = fontSelect.locator('optgroup[label="Installed fonts"]');
  await expect(installedGroup).toBeAttached();
  expect(await installedGroup.locator("option").count()).toBeGreaterThan(0);

  await frame.locator('[data-testid="docx-tb-save"]').click();
  await expect(page.getByText("Unsaved changes")).toBeHidden({ timeout: 15_000 });

  // Bold + list survive the saveDocx round-trip (numbering.xml included).
  const frame2 = await openDocx(page, "toolbar.docx");
  const editor2 = frame2.locator(".ProseMirror").first();
  await expect(editor2.locator("strong").first()).toBeVisible({ timeout: 30_000 });
  await expect(editor2.locator(".doc-li").first()).toBeVisible();
});

test("docx save clears the dirty badge — including a second edit+save cycle", async ({
  page,
}) => {
  const res = await putDocument("badge.docx", await makeDocx("Badge target"));
  expect(res.ok).toBe(true);

  const frame = await openDocx(page, "badge.docx");
  const editor = frame.locator(".ProseMirror").first();
  const badge = page.getByText("Unsaved changes");

  // Two cycles: a stale-revision bug surfaces on the second save, when the
  // daemon's echo of the first commit must not read as an external change.
  for (const text of [" one", " two"]) {
    await editor.locator("p").first().click();
    await page.keyboard.press("End");
    await page.keyboard.type(text);
    await expect(badge).toBeVisible();
    await frame.locator('[data-testid="docx-tb-save"]').click();
    await expect(badge).toBeHidden({ timeout: 5_000 });
    // The daemon echoes our own commit — it must not flag a conflict.
    await expect(frame.locator(".doc-conflict-banner")).toHaveCount(0);
    // Let any deferred revision-changed evaluation settle before cycling.
    await page.waitForTimeout(500);
    await expect(badge).toBeHidden();
    await expect(frame.locator(".doc-conflict-banner")).toHaveCount(0);
  }

  // And the content survived both saves.
  const frame2 = await openDocx(page, "badge.docx");
  await expect(frame2.locator(".ProseMirror").first()).toContainText(
    "Badge target one two",
    { timeout: 30_000 },
  );
});

test("external edit while dirty shows a conflict banner without reloading", async ({
  page,
  request,
}) => {
  // Fresh fixture so the two tests don't share state.
  const res = await putDocument("conflict.docx", await makeDocx("Conflict base"));
  expect(res.ok).toBe(true);

  const frame = await openDocx(page, "conflict.docx");
  const editor = frame.locator(".ProseMirror").first();
  await editor.locator("p").first().click();
  await page.keyboard.type(" local-edits");
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  // Modify the same file underneath the open session.
  const rev = await (
    await request.get(`${cabinet.appUrl}/api/documents/revision?path=conflict.docx`)
  ).json();
  const overwrite = await putDocument(
    "conflict.docx",
    await makeDocx("Conflict base externally changed"),
    rev.revision,
  );
  expect(overwrite.ok).toBe(true);

  // The frame's conflict banner must appear; the local edits must NOT be
  // silently reloaded away.
  await expect(frame.locator(".doc-conflict-banner")).toBeVisible({ timeout: 15_000 });
  await expect(editor).toContainText("local-edits");
  await page.screenshot({ path: `${SHOTS}/documents-conflict.png` });
});
