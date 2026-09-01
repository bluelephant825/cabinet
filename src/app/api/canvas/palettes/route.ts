import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { DATA_DIR } from "@/lib/storage/path-utils";
import { ensureDirectory, fileExists, readFileContent, writeFileAtomic } from "@/lib/storage/fs-operations";
import { DEFAULT_CANVAS_PALETTE_CONFIG, parseCanvasPaletteConfig } from "@/lib/canvas/palettes";

const PALETTES_FILE = path.join(DATA_DIR, ".agents", ".config", "canvas-palettes.json");

export function canvasPalettesFile(): string {
  return PALETTES_FILE;
}

export async function GET() {
  try {
    if (!(await fileExists(PALETTES_FILE))) return NextResponse.json(DEFAULT_CANVAS_PALETTE_CONFIG);
    const config = parseCanvasPaletteConfig(JSON.parse(await readFileContent(PALETTES_FILE)));
    if (!config) return NextResponse.json({ error: "Stored canvas palettes are invalid" }, { status: 500 });
    return NextResponse.json(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load canvas palettes";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const config = parseCanvasPaletteConfig(body);
  if (!config) return NextResponse.json({ error: "Invalid canvas palette configuration" }, { status: 400 });

  try {
    await ensureDirectory(path.dirname(PALETTES_FILE));
    await writeFileAtomic(PALETTES_FILE, `${JSON.stringify(config, null, 2)}\n`);
    return NextResponse.json(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save canvas palettes";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
