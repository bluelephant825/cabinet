import { NextRequest, NextResponse } from "next/server";
import { removeKnowledgeSource } from "@/lib/knowledge-sources/store";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const cabinet = request.nextUrl.searchParams.get("cabinet") ?? "";
    const removed = await removeKnowledgeSource(cabinet, id);
    if (!removed) {
      return NextResponse.json({ error: "Mount not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
