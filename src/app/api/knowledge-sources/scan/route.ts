import { NextResponse } from "next/server";
import { scanCloudStorage } from "@/lib/google-drive/detect-desktop";

export const dynamic = "force-dynamic";

/**
 * Auto-scan installed desktop-sync providers/accounts at once (Connect
 * Knowledge P2, docs/CONNECT_KNOWLEDGE_PRD.md §12). Reads
 * ~/Library/CloudStorage/* + iCloud and returns the detected accounts so a
 * picker can offer one-click "connect a detected account".
 */
export async function GET() {
  try {
    const accounts = await scanCloudStorage();
    return NextResponse.json({ accounts });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
