import path from "path";
import fsp from "fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { readFileContent, writeFileAtomic } from "@/lib/storage/fs-operations";
import { DATA_DIR } from "@/lib/storage/path-utils";
import palettesSeedJson from "@/components/settings/color-palettes.json";
import pastelPalettesSeedJson from "@/components/settings/pastel-color-palettes.json";

type ColorPalettesMap = Record<string, string[]>;

// The palette seeds are imported so they ship inside the compiled bundle —
// the src/ tree is not staged into the packaged standalone app, so reading
// them off process.cwd() 500s there. User-customized palettes persist under
// the managed data dir, never inside the app bundle.
const PALETTES_FILE = path.join(DATA_DIR, ".agents", ".config", "color-palettes.json");
const PALETTES_SEED = palettesSeedJson as ColorPalettesMap;
const PASTEL_PALETTES_SEED = pastelPalettesSeedJson as ColorPalettesMap;

function isValidColorPalettesMap(value: unknown): value is ColorPalettesMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([name, colors]) => {
    if (!name || typeof name !== "string") return false;
    if (!Array.isArray(colors) || colors.length !== 6) return false;
    return colors.every((color) => typeof color === "string" && /^#[0-9A-Fa-f]{6}$/.test(color));
  });
}

function sortPalettes(map: ColorPalettesMap): ColorPalettesMap {
  return Object.fromEntries(
    Object.entries(map)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, colors]) => [
        name,
        colors.map((color) => color.toUpperCase()),
      ])
  );
}

async function readUserPalettes(): Promise<ColorPalettesMap | null> {
  try {
    const parsed = JSON.parse(await readFileContent(PALETTES_FILE)) as unknown;
    return isValidColorPalettesMap(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeUserPalettes(palettes: ColorPalettesMap): Promise<void> {
  await fsp.mkdir(path.dirname(PALETTES_FILE), { recursive: true });
  await writeFileAtomic(PALETTES_FILE, `${JSON.stringify(palettes, null, 4)}\n`);
}

export async function GET() {
  const palettes = (await readUserPalettes()) ?? PALETTES_SEED;
  if (!isValidColorPalettesMap(palettes)) {
    return NextResponse.json({ error: "Invalid color palettes file" }, { status: 500 });
  }
  return NextResponse.json({ palettes });
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { action?: unknown };
    if (body.action !== "reset") {
      return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }
    if (!isValidColorPalettesMap(PASTEL_PALETTES_SEED)) {
      return NextResponse.json({ error: "Invalid pastel color palettes file" }, { status: 500 });
    }
    const ordered = sortPalettes(PASTEL_PALETTES_SEED);
    await writeUserPalettes(ordered);
    return NextResponse.json({ ok: true, palettes: ordered });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = (await request.json()) as { palettes?: unknown };
    if (!isValidColorPalettesMap(body.palettes)) {
      return NextResponse.json({ error: "Invalid palettes payload" }, { status: 400 });
    }
    const ordered = sortPalettes(body.palettes);
    await writeUserPalettes(ordered);
    return NextResponse.json({ ok: true, palettes: ordered });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
