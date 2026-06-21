import { NextRequest, NextResponse } from "next/server";
import { importAppleNotes, AppleNotesPermissionError } from "@/lib/apple-notes/import";

export const dynamic = "force-dynamic";

/**
 * Import (or re-import) the user's Apple Notes into the tree as local Markdown.
 * macOS only — there's no Notes export file, so we read Notes.app directly via
 * AppleScript (osascript). Body: `{ parentPath? }`.
 *
 * Streams newline-delimited JSON progress so the dialog can show a live counter
 * instead of a bare spinner: `{type:"extracting"}`, `{type:"extracted",total}`,
 * `{type:"progress",done,total,name}`, then a terminal `{type:"done",summary}`
 * or `{type:"error",message}`. One-way; re-import upserts by note id.
 */
export async function POST(req: NextRequest) {
  if (process.platform !== "darwin") {
    return NextResponse.json(
      { error: "Apple Notes import is only available on macOS." },
      { status: 400 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as { parentPath?: string };
  const parentPath = body.parentPath?.trim() || "";
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          /* client disconnected */
        }
      };
      try {
        const summary = await importAppleNotes(parentPath, send);
        send({ type: "done", summary });
      } catch (error) {
        send({
          type: "error",
          message: error instanceof Error ? error.message : "Unknown error",
          permission: error instanceof AppleNotesPermissionError,
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
