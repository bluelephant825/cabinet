import { NextRequest, NextResponse } from "next/server";
import {
  compileTypstSource,
  typstErrorMessage,
  validateTypstSource,
} from "./compiler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = 1_100_000;

async function readBoundedJson(req: NextRequest): Promise<unknown> {
  const declaredSize = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_REQUEST_BYTES) {
    throw new RangeError("Request body is too large");
  }
  if (!req.body) return null;

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new RangeError("Request body is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function POST(req: NextRequest) {
  let source: string;
  try {
    const body = await readBoundedJson(req) as { code?: unknown } | null;
    source = validateTypstSource(body?.code);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON body";
    const status = error instanceof RangeError ? 413 : 400;
    return NextResponse.json({ error: message }, { status });
  }

  try {
    const pdf = await compileTypstSource(source);
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": 'inline; filename="document.pdf"',
        "Content-Type": "application/pdf",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: typstErrorMessage(error) }, { status: 422 });
  }
}
