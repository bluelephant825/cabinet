import { NextRequest, NextResponse } from "next/server";
import {
  InvalidClipUriError,
  normalizeClipPath,
  parseClipUri,
} from "@/lib/clipper/clip-uri";
import {
  ClipboardUnavailableError,
  readSystemClipboard,
} from "@/lib/clipper/read-clipboard";
import { saveClip, StorageFullError } from "@/lib/clipper/save-clip";
import { ReadOnlySourceError } from "@/lib/knowledge-sources/store";
import { staleProcessResponse } from "@/lib/api/stale-process-response";

const storageFull = () =>
  NextResponse.json(
    { error: "Storage full: the free plan is capped. Upgrade for more room.", errorKind: "storage" },
    { status: 402 }
  );

const clipboardEmpty = () =>
  NextResponse.json(
    { error: "Clipboard is empty or unreadable.", errorKind: "clipboard" },
    { status: 422 }
  );

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    let file: string;
    let silent = false;
    let markdown: string | undefined;

    if (body && typeof body.uri === "string") {
      const clip = parseClipUri(body.uri);
      file = clip.file;
      silent = clip.silent;
      if (clip.content !== undefined) {
        markdown = clip.content;
      } else if (clip.clipboard) {
        try {
          markdown = await readSystemClipboard();
        } catch (error) {
          if (error instanceof ClipboardUnavailableError) return clipboardEmpty();
          throw error;
        }
      } else {
        return NextResponse.json(
          { error: "No content: pass content= or clipboard=true." },
          { status: 400 }
        );
      }
    } else if (
      body &&
      typeof body.file === "string" &&
      typeof body.markdown === "string"
    ) {
      file = normalizeClipPath(body.file);
      markdown = body.markdown;
    } else {
      return NextResponse.json(
        { error: "Expected { uri } or { file, markdown }." },
        { status: 400 }
      );
    }

    if (!markdown || !markdown.trim()) return clipboardEmpty();

    const saved = await saveClip({ file, markdown });
    return NextResponse.json({ ok: true, path: saved.path, title: saved.title, silent });
  } catch (error) {
    const stale = staleProcessResponse(error);
    if (stale) return stale;
    if (error instanceof InvalidClipUriError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ReadOnlySourceError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof StorageFullError) return storageFull();
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
