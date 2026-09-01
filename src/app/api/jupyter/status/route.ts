import { NextResponse } from "next/server";
import { getDaemonUrl, getOrCreateDaemonToken } from "@/lib/agents/daemon-auth";

export async function GET() {
  try {
    const token = await getOrCreateDaemonToken();
    const response = await fetch(`${getDaemonUrl()}/jupyter/status`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return NextResponse.json({ available: false }, { status: response.status });
    const status = await response.json() as { available?: boolean };
    return NextResponse.json({ available: status.available === true });
  } catch {
    return NextResponse.json({ available: false });
  }
}
