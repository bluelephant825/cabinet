import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/auth/request-gate";
import { invalidateTreeCache } from "@/lib/storage/tree-builder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Daemon → Next ping after an agent-actor document commit. Agent calls
 * (cabinet-documents) bypass the Next routes that normally record mutations
 * and refresh the tree cache, so the daemon records history itself and POSTs
 * here just to invalidate the cached tree.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const denied = await requireApiAuth(req);
  if (denied) return denied;
  invalidateTreeCache();
  return NextResponse.json({ ok: true });
}
