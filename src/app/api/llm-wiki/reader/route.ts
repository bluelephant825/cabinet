import { NextRequest, NextResponse } from "next/server";
import { DATA_DIR, resolveContentPath } from "@/lib/storage/path-utils";
import { readRawSource } from "@/lib/llm-wiki/raw-reader";
import { RawPublicationStore } from "@/lib/llm-wiki/raw-publication";
import { opaqueId } from "@/lib/llm-wiki/config";
import type { SourceId, SourceVersionId } from "@/lib/llm-wiki/types";
import { assertWritablePath } from "@/lib/knowledge-sources/store";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  try {
    resolveContentPath(""); // Active-root stale-process guard.
    const query = req.nextUrl.searchParams;
    if (query.has("writable")) {
      await assertWritablePath(query.get("path") ?? "");
      return NextResponse.json({ writable: true });
    }
    if (query.has("source")) {
      const id = opaqueId(query.get("source")) as SourceId;
      const version = opaqueId(query.get("version")) as SourceVersionId;
      const file = query.get("file") ?? "";
      const captured = await new RawPublicationStore(DATA_DIR).readCapturedFile(id, version, file);
      const inline = query.get("inline") === "1" && file === "original.pdf" && captured.version.originalFormat === "pdf";
      return new NextResponse(new Uint8Array(captured.bytes), { headers: {
        "Content-Type": inline ? "application/pdf" : "application/octet-stream",
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.split("/").pop()!)}`,
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
      } });
    }
    return NextResponse.json(await readRawSource(DATA_DIR, query.get("path") ?? "", query.get("version")), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to read captured Source" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
