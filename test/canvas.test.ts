import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET, PUT, canvasVirtualPath, parseCanvasCabinetPath } from "@/app/api/canvas/route";
import { parseCanvasSnapshot } from "@/lib/canvas/snapshot";
import { markdownToHtml } from "@/lib/markdown/to-html";
import { useAppStore } from "@/stores/app-store";
import { canvasPreviewKind } from "@/components/layout/canvas-view";
import { renderLatexToHtml } from "@/components/editor/latex-render";
import { sanitizeHtml } from "@/lib/security/sanitize";
import type { TreeNode } from "@/types";

const validSnapshot = {
  version: 1,
  boards: {
    "room/notes": {
      zoom: 1.25,
      cards: {
        "room/notes/brief.md": { x: 10, y: -20, width: 360, height: 300 },
      },
    },
  },
};

test("canvas snapshot validation accepts only the bounded v1 shape", () => {
  assert.deepEqual(parseCanvasSnapshot(validSnapshot), validSnapshot);
  assert.equal(parseCanvasSnapshot({ ...validSnapshot, extra: true }), null);
  assert.equal(parseCanvasSnapshot({ version: 1, boards: { "../room": { zoom: 1, cards: {} } } }), null);
  assert.equal(parseCanvasSnapshot({ version: 1, boards: { room: { zoom: Number.NaN, cards: {} } } }), null);
  assert.equal(parseCanvasSnapshot({ version: 1, boards: { room: { zoom: 1, cards: { page: { x: 0, y: 0, width: 10, height: 300 } } } } }), null);
  assert.equal(parseCanvasSnapshot({ version: 1, boards: { room: { zoom: 1, cards: { page: { x: 0, y: 0, width: 360, height: 300, color: "red" } } } } }), null);
});

test("canvas route requires a strict cabinetPath before touching storage", async () => {
  for (const url of [
    "http://localhost/api/canvas",
    "http://localhost/api/canvas?cabinetPath=",
    "http://localhost/api/canvas?cabinetPath=../outside",
    "http://localhost/api/canvas?cabinetPath=/absolute",
    "http://localhost/api/canvas?cabinetPath=room/./outside",
    "http://localhost/api/canvas?cabinetPath=room%5Coutside",
  ]) {
    const request = new NextRequest(url);
    assert.equal(parseCanvasCabinetPath(request), null);
    assert.equal((await GET(request)).status, 400);
  }
  assert.equal(parseCanvasCabinetPath(new NextRequest("http://localhost/api/canvas?cabinetPath=.")), ".");
  assert.equal(parseCanvasCabinetPath(new NextRequest("http://localhost/api/canvas?cabinetPath=room/nested")), "room/nested");
});

test("canvas route rejects malformed JSON and snapshots without writing", async () => {
  const malformed = new NextRequest("http://localhost/api/canvas?cabinetPath=room", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assert.equal((await PUT(malformed)).status, 400);

  const invalid = new NextRequest("http://localhost/api/canvas?cabinetPath=room", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: 1, boards: [], extra: true }),
  });
  assert.equal((await PUT(invalid)).status, 400);

  const missingCabinet = new NextRequest("http://localhost/api/canvas?cabinetPath=definitely-missing-canvas-test-room", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validSnapshot),
  });
  assert.equal((await PUT(missingCabinet)).status, 404);
});

test("canvas route stores layout in current per-cabinet config and guards that path", () => {
  assert.equal(canvasVirtualPath("."), ".agents/.config/canvas.json");
  assert.equal(canvasVirtualPath("room/linked"), "room/linked/.agents/.config/canvas.json");
});

test("canvas routes Markdown and LaTeX nodes to the upstream preview renderers", async () => {
  const node = (name: string, type: TreeNode["type"]): TreeNode => ({ name, path: `room/${name}`, type });
  assert.equal(canvasPreviewKind(node("brief.md", "file")), "markdown");
  assert.equal(canvasPreviewKind(node("room", "directory")), "markdown");
  assert.equal(canvasPreviewKind(node("proof.tex", "latex")), "latex");
  assert.equal(canvasPreviewKind(node("paper.latex", "latex")), "latex");
  assert.equal(canvasPreviewKind(node("script.ts", "code")), "other");

  const markdown = await markdownToHtml('# Brief\n\n<img src="x" onerror="alert(1)">');
  assert.match(markdown, /<h1 id="brief">Brief<\/h1>/);
  assert.doesNotMatch(sanitizeHtml(markdown, "rich"), /onerror|alert\(1\)/);

  const rendered = renderLatexToHtml("\\section{Proof}\n\\[x^2 + y^2 = z^2\\]");
  assert.equal(rendered.ok, true);
  assert.match(rendered.html, /<h2>Proof<\/h2>/);
  assert.match(rendered.html, /class="katex-display/);
  assert.equal(renderLatexToHtml("   \n").ok, false);
});

test("app store enters and leaves canvas without changing browse state", () => {
  const original = useAppStore.getState();
  useAppStore.setState({ appMode: "edit", browseUrl: "https://example.com" });
  useAppStore.getState().setAppMode("canvas");
  assert.equal(useAppStore.getState().appMode, "canvas");
  assert.equal(useAppStore.getState().browseUrl, "https://example.com");
  useAppStore.getState().setAppMode("edit");
  assert.equal(useAppStore.getState().appMode, "edit");
  useAppStore.setState({ appMode: original.appMode, browseUrl: original.browseUrl });
});
