import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/auth/request-gate";
import { getDaemonUrl, getOrCreateDaemonTokenSync } from "@/lib/agents/daemon-auth";
import { matchesChannelFrame } from "@/lib/documents/events-filter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Channels a browser may subscribe to — extend deliberately, not by echo. */
const ALLOWED_CHANNELS = new Set(["documents"]);
const HEARTBEAT_MS = 25_000;

/**
 * SSE relay for one daemon event-bus channel (`/events` WebSocket). The
 * browser can't hold the daemon token, so this route connects server-side,
 * narrows the daemon subscription to `?channel=` and forwards only frames
 * whose `channel` matches — other bus traffic never reaches the client.
 */
export async function GET(req: NextRequest) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;

  const channel = req.nextUrl.searchParams.get("channel") ?? "";
  if (!ALLOWED_CHANNELS.has(channel)) {
    return NextResponse.json(
      { error: `Unknown events channel "${channel}"` },
      { status: 400 },
    );
  }

  const token = getOrCreateDaemonTokenSync();
  const wsUrl = `${getDaemonUrl().replace(/^http/, "ws")}/events?token=${encodeURIComponent(token)}`;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const { WebSocket } = await import("ws");
      const ws = new WebSocket(wsUrl);
      // Subscribers default to "*" on the daemon — narrow before traffic flows.
      ws.on("open", () => {
        ws.send(JSON.stringify({ unsubscribe: "*" }));
        ws.send(JSON.stringify({ subscribe: channel }));
      });
      ws.on("message", (data) => {
        const text = data.toString();
        if (!matchesChannelFrame(text, channel)) return;
        try {
          controller.enqueue(encoder.encode(`data: ${text}\n\n`));
        } catch {
          /* stream already closed */
        }
      });
      // Comment-frame heartbeat keeps proxies from dropping the idle stream.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          /* stream already closed */
        }
      }, HEARTBEAT_MS);
      const close = () => {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      ws.on("close", close);
      ws.on("error", close);
      req.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        ws.close();
      });
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
