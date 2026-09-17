import { NextRequest, NextResponse } from "next/server";
import { DATA_DIR, resolveContentPath } from "@/lib/storage/path-utils";
import { normalizeVirtualPath } from "@/lib/virtual-paths";
import { readWikiCabinet } from "@/lib/llm-wiki/config";
import { readWikiGraph } from "@/lib/llm-wiki/graph/store";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    resolveContentPath(""); // Active-root stale-process guard.
    const requested = normalizeVirtualPath(req.nextUrl.searchParams.get("path") ?? "");
    const cabinet = await readWikiCabinet(DATA_DIR);
    if (!cabinet?.config.enabled || requested !== `${cabinet.config.paths.wiki}/graph.json`) {
      return NextResponse.json({ error: "Not a Wiki graph" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    let graph;
    try {
      graph = await readWikiGraph(DATA_DIR, cabinet.config.paths.wiki);
    } catch {
      return NextResponse.json({ error: "Not a Wiki graph" }, { status: 409, headers: { "Cache-Control": "no-store" } });
    }
    if (!graph) return NextResponse.json({ error: "No knowledge graph yet" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    return NextResponse.json(graph, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to read Wiki graph" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
