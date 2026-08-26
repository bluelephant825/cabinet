import { NextResponse } from "next/server";
import { providerRegistry } from "@/lib/agents/provider-registry";

interface CachedStatus {
  providers: { id: string; name: string; available: boolean; authenticated: boolean }[];
  anyReady: boolean;
}

let cachedResult: CachedStatus | null = null;
let cachedAt = 0;
const CACHE_TTL = 30_000;

export async function GET(req: Request) {
  try {
    const now = Date.now();
    // `?refresh=1` bypasses the cache — the setup dialog polls this so a just-
    // finished install / sign-in is detected promptly instead of up to 30s late.
    const fresh = new URL(req.url).searchParams.get("refresh") === "1";
    if (!fresh && cachedResult && now - cachedAt < CACHE_TTL) {
      return NextResponse.json(cachedResult);
    }

    const providers = providerRegistry.listAll();
    const results = await Promise.all(
      providers.map(async (p) => {
        const status = await p.healthCheck();
        return {
          id: p.id,
          name: p.name,
          available: status.available,
          authenticated: status.authenticated,
        };
      }),
    );

    const response: CachedStatus = {
      providers: results,
      anyReady: results.some((p) => p.available && p.authenticated),
    };

    cachedResult = response;
    cachedAt = now;

    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
