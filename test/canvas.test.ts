import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { NextRequest } from "next/server";
import { GET, PUT, canvasVirtualPath, parseCanvasCabinetPath } from "@/app/api/canvas/route";
import {
  GET as getPalettes,
  PUT as putPalettes,
  canvasPalettesFile,
} from "@/app/api/canvas/palettes/route";
import {
  DEFAULT_CANVAS_PALETTE_CONFIG,
  isCanvasColor,
  isCanvasPaletteId,
  parseCanvasPaletteConfig,
} from "@/lib/canvas/palettes";
import { parseCanvasSnapshot } from "@/lib/canvas/snapshot";
import { useAppStore } from "@/stores/app-store";

const validSnapshot = {
  version: 1 as const,
  boards: {
    "room/notes": {
      zoom: 1.25,
      palette: "pastel",
      cards: {
        "room/notes/brief.md": {
          x: 10,
          y: -20,
          width: 360,
          height: 300,
          color: "#FFD6A5",
        },
      },
    },
  },
};

const validPaletteConfig = {
  version: 1 as const,
  selectedPalette: "custom",
  palettes: [
    { id: "custom", name: "  Custom palette  ", colors: ["#012345", "#aBcDeF"] },
    { id: "second-2", name: "Second", colors: ["#FEDCBA"] },
  ],
};

test("canvas palette primitives accept only safe ids and six-digit hex colors", () => {
  for (const value of ["cabinet", "second-2", `a${"b".repeat(47)}`]) {
    assert.equal(isCanvasPaletteId(value), true);
  }
  for (const value of ["", "Uppercase", "-leading", "space here", `a${"b".repeat(48)}`, null]) {
    assert.equal(isCanvasPaletteId(value), false);
  }
  for (const value of ["#000000", "#ABCDEF", "#aBc123"]) {
    assert.equal(isCanvasColor(value), true);
  }
  for (const value of ["#fff", "000000", "#GGGGGG", "#00000000", 123]) {
    assert.equal(isCanvasColor(value), false);
  }
});

test("canvas palette config validation normalizes names and copies accepted data", () => {
  const parsed = parseCanvasPaletteConfig(validPaletteConfig);
  assert.deepEqual(parsed, {
    ...validPaletteConfig,
    palettes: [
      { ...validPaletteConfig.palettes[0], name: "Custom palette" },
      validPaletteConfig.palettes[1],
    ],
  });
  assert.notEqual(parsed?.palettes, validPaletteConfig.palettes);
  assert.notEqual(parsed?.palettes[0].colors, validPaletteConfig.palettes[0].colors);
  assert.deepEqual(parseCanvasPaletteConfig(DEFAULT_CANVAS_PALETTE_CONFIG), DEFAULT_CANVAS_PALETTE_CONFIG);
});

test("canvas palette config validation rejects unsafe, ambiguous, and unbounded shapes", () => {
  const palette = { id: "custom", name: "Custom", colors: ["#012345"] };
  const invalidConfigs: unknown[] = [
    null,
    { version: 1, selectedPalette: "custom", palettes: [palette], extra: true },
    { version: 2, selectedPalette: "custom", palettes: [palette] },
    { version: 1, selectedPalette: "missing", palettes: [palette] },
    { version: 1, selectedPalette: "Bad ID", palettes: [palette] },
    { version: 1, selectedPalette: "custom", palettes: [] },
    { version: 1, selectedPalette: "custom", palettes: Array.from({ length: 25 }, (_, index) => ({ id: `p${index}`, name: "P", colors: ["#000000"] })) },
    { version: 1, selectedPalette: "custom", palettes: [palette, palette] },
    { version: 1, selectedPalette: "custom", palettes: [{ ...palette, id: "../custom" }] },
    { version: 1, selectedPalette: "custom", palettes: [{ ...palette, name: "   " }] },
    { version: 1, selectedPalette: "custom", palettes: [{ ...palette, name: "x".repeat(81) }] },
    { version: 1, selectedPalette: "custom", palettes: [{ ...palette, colors: [] }] },
    { version: 1, selectedPalette: "custom", palettes: [{ ...palette, colors: Array(13).fill("#000000") }] },
    { version: 1, selectedPalette: "custom", palettes: [{ ...palette, colors: ["red"] }] },
    { version: 1, selectedPalette: "custom", palettes: [{ ...palette, extra: true }] },
  ];
  for (const config of invalidConfigs) assert.equal(parseCanvasPaletteConfig(config), null);
});

test("canvas snapshot validation accepts palette metadata while remaining v1-compatible", () => {
  assert.deepEqual(parseCanvasSnapshot(validSnapshot), validSnapshot);
  const legacy = {
    version: 1,
    boards: { room: { zoom: 1, cards: { page: { x: 0, y: 0, width: 360, height: 300 } } } },
  };
  assert.deepEqual(parseCanvasSnapshot(legacy), legacy);

  const invalidSnapshots: unknown[] = [
    { ...validSnapshot, extra: true },
    { version: 1, boards: { "../room": { zoom: 1, cards: {} } } },
    { version: 1, boards: { room: { zoom: Number.NaN, cards: {} } } },
    { version: 1, boards: { room: { zoom: 1, palette: "Bad ID", cards: {} } } },
    { version: 1, boards: { room: { zoom: 1, palette: "pastel", extra: true, cards: {} } } },
    { version: 1, boards: { room: { zoom: 1, cards: { page: { x: 0, y: 0, width: 10, height: 300 } } } } },
    { version: 1, boards: { room: { zoom: 1, cards: { page: { x: 0, y: 0, width: 360, height: 300, color: "red" } } } } },
    { version: 1, boards: { room: { zoom: 1, cards: { page: { x: 0, y: 0, width: 360, height: 300, color: "#000000", extra: true } } } } },
  ];
  for (const snapshot of invalidSnapshots) assert.equal(parseCanvasSnapshot(snapshot), null);
});

test("canvas palettes API defaults, validates, normalizes, persists, and detects corrupt storage", async () => {
  const file = canvasPalettesFile();
  await fs.rm(file, { force: true });
  try {
    const defaultResponse = await getPalettes();
    assert.equal(defaultResponse.status, 200);
    assert.deepEqual(await defaultResponse.json(), DEFAULT_CANVAS_PALETTE_CONFIG);

    const malformed = new NextRequest("http://localhost/api/canvas/palettes", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal((await putPalettes(malformed)).status, 400);

    const invalid = new NextRequest("http://localhost/api/canvas/palettes", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validPaletteConfig, selectedPalette: "missing" }),
    });
    assert.equal((await putPalettes(invalid)).status, 400);

    const valid = new NextRequest("http://localhost/api/canvas/palettes", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validPaletteConfig),
    });
    const putResponse = await putPalettes(valid);
    assert.equal(putResponse.status, 200);
    const normalized = { ...validPaletteConfig, palettes: [{ ...validPaletteConfig.palettes[0], name: "Custom palette" }, validPaletteConfig.palettes[1]] };
    assert.deepEqual(await putResponse.json(), normalized);
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), normalized);
    assert.deepEqual(await (await getPalettes()).json(), normalized);

    await fs.writeFile(file, "{ not json\n", "utf8");
    const corruptResponse = await getPalettes();
    assert.equal(corruptResponse.status, 500);
    assert.match((await corruptResponse.json()).error, /JSON|property name/i);
  } finally {
    await fs.rm(file, { force: true });
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
