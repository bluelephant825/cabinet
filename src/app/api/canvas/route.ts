import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { normalizeCabinetPath, ROOT_CABINET_PATH } from "@/lib/cabinets/paths";
import { resolveCabinetDir } from "@/lib/cabinets/server-paths";
import {
  ensureDirectory,
  fileExists,
  readFileContent,
  writeFileAtomic,
} from "@/lib/storage/fs-operations";
import {
  assertWritablePath,
  ReadOnlySourceError,
} from "@/lib/knowledge-sources/store";
import {
  isSafeCanvasPath,
  parseCanvasSnapshot,
} from "@/lib/canvas/snapshot";

const CANVAS_RELATIVE_PATH = path.join(".agents", ".config", "canvas.json");
const CANVAS_VIRTUAL_PATH = ".agents/.config/canvas.json";

export function parseCanvasCabinetPath(request: NextRequest): string | null {
  const raw = request.nextUrl.searchParams.get("cabinetPath");
  if (raw === null || raw.trim() === "") return null;
  const trimmed = raw.trim();
  if (!isSafeCanvasPath(trimmed)) return null;
  return normalizeCabinetPath(trimmed, true) ?? ROOT_CABINET_PATH;
}

function invalidCabinetPath() {
  return NextResponse.json({ error: "Invalid cabinetPath" }, { status: 400 });
}

export function canvasVirtualPath(cabinetPath: string): string {
  return cabinetPath === ROOT_CABINET_PATH
    ? CANVAS_VIRTUAL_PATH
    : `${cabinetPath}/${CANVAS_VIRTUAL_PATH}`;
}

export async function GET(request: NextRequest) {
  const cabinetPath = parseCanvasCabinetPath(request);
  if (!cabinetPath) return invalidCabinetPath();

  try {
    const file = path.join(resolveCabinetDir(cabinetPath), CANVAS_RELATIVE_PATH);
    if (!(await fileExists(file))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const snapshot = parseCanvasSnapshot(JSON.parse(await readFileContent(file)));
    if (!snapshot) {
      return NextResponse.json({ error: "Stored canvas is invalid" }, { status: 500 });
    }
    return NextResponse.json(snapshot);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const cabinetPath = parseCanvasCabinetPath(request);
  if (!cabinetPath) return invalidCabinetPath();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const snapshot = parseCanvasSnapshot(body);
  if (!snapshot) {
    return NextResponse.json({ error: "Invalid canvas snapshot" }, { status: 400 });
  }

  try {
    const cabinetDir = resolveCabinetDir(cabinetPath);
    if (!(await fileExists(cabinetDir))) {
      return NextResponse.json({ error: "Cabinet not found" }, { status: 404 });
    }
    await assertWritablePath(canvasVirtualPath(cabinetPath));
    const file = path.join(cabinetDir, CANVAS_RELATIVE_PATH);
    await ensureDirectory(path.dirname(file));
    await writeFileAtomic(file, `${JSON.stringify(snapshot, null, 2)}\n`);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof ReadOnlySourceError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
