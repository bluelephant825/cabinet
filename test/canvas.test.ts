import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET, PUT, canvasVirtualPath, parseCanvasCabinetPath } from "@/app/api/canvas/route";
import {
  CANVAS_MAX_CARD_HEIGHT,
  CANVAS_MAX_CARD_WIDTH,
  CANVAS_MIN_CARD_HEIGHT,
  CANVAS_MIN_CARD_WIDTH,
  computeCanvasAutoLayout,
  parseCanvasSnapshot,
} from "@/lib/canvas/snapshot";
import { useAppStore } from "@/stores/app-store";

const validSnapshot = {
  version: 2,
  boards: {
    "room/notes": {
      zoom: 1.25,
      manualLayout: false,
      cards: {
        "room/notes/brief.md": { x: 10, y: -20, width: 360, height: 300 },
      },
    },
  },
};

test("canvas snapshot validation accepts v2 and migrates bounded v1 snapshots", () => {
  assert.deepEqual(parseCanvasSnapshot(validSnapshot), validSnapshot);
  assert.deepEqual(
    parseCanvasSnapshot({
      version: 1,
      boards: {
        empty: { zoom: 1, cards: {} },
        room: {
          zoom: 1.5,
          cards: { "room/page.md": { x: 10, y: 20, width: 360, height: 300 } },
        },
      },
    }),
    {
      version: 2,
      boards: {
        empty: { zoom: 1, manualLayout: false, cards: {} },
        room: {
          zoom: 1.5,
          manualLayout: true,
          cards: { "room/page.md": { x: 10, y: 20, width: 360, height: 300 } },
        },
      },
    },
  );
  assert.equal(parseCanvasSnapshot({ ...validSnapshot, extra: true }), null);
  assert.equal(parseCanvasSnapshot({ version: 2, boards: { room: { zoom: 1, cards: {} } } }), null);
  assert.equal(parseCanvasSnapshot({ version: 2, boards: { room: { zoom: 1, manualLayout: "yes", cards: {} } } }), null);
  assert.equal(parseCanvasSnapshot({ version: 1, boards: { "../room": { zoom: 1, cards: {} } } }), null);
  assert.equal(parseCanvasSnapshot({ version: 1, boards: { room: { zoom: Number.NaN, cards: {} } } }), null);
  assert.equal(parseCanvasSnapshot({ version: 1, boards: { room: { zoom: 1, cards: { page: { x: 0, y: 0, width: 10, height: 300 } } } } }), null);
  assert.equal(parseCanvasSnapshot({ version: 1, boards: { room: { zoom: 1, cards: { page: { x: 0, y: 0, width: 360, height: 300, color: "red" } } } } }), null);
});

test("canvas auto layout is deterministic and clamps measured card sizes", () => {
  const cards = [
    { path: "room/min.md", width: 10.4, height: -20 },
    { path: "room/rounded.md", width: 360.6, height: 240.4 },
    { path: "room/max.md", width: 10_000, height: 10_000 },
  ];
  const layout = computeCanvasAutoLayout(cards);

  assert.deepEqual(computeCanvasAutoLayout([]), {});
  assert.deepEqual(layout, computeCanvasAutoLayout(cards));
  assert.deepEqual(Object.keys(layout), cards.map((card) => card.path));
  assert.deepEqual(
    cards.map((card) => ({ width: layout[card.path].width, height: layout[card.path].height })),
    [
      { width: CANVAS_MIN_CARD_WIDTH, height: CANVAS_MIN_CARD_HEIGHT },
      { width: 361, height: 240 },
      { width: CANVAS_MAX_CARD_WIDTH, height: CANVAS_MAX_CARD_HEIGHT },
    ],
  );
});

test("canvas auto layout centers finite cards without overlap", () => {
  const cards = [
    { path: "room/a.md", width: 360, height: 300 },
    { path: "room/b.md", width: 420, height: 240 },
    { path: "room/c.md", width: 300, height: 500 },
    { path: "room/d.md", width: 380, height: 320 },
    { path: "room/e.md", width: 280, height: 180 },
  ];
  const boxes = Object.values(computeCanvasAutoLayout(cards));
  const left = Math.min(...boxes.map((box) => box.x));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const top = Math.min(...boxes.map((box) => box.y));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));

  assert.ok(boxes.every((box) => Object.values(box).every(Number.isFinite)));
  assert.ok(Math.abs((left + right) / 2 - 4_000) <= 1);
  assert.ok(Math.abs((top + bottom) / 2 - 4_000) <= 1);
  for (let first = 0; first < boxes.length; first += 1) {
    for (let second = first + 1; second < boxes.length; second += 1) {
      const a = boxes[first];
      const b = boxes[second];
      const overlaps =
        a.x < b.x + b.width && a.x + a.width > b.x &&
        a.y < b.y + b.height && a.y + a.height > b.y;
      assert.equal(overlaps, false, `cards ${first} and ${second} overlap`);
    }
  }
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
