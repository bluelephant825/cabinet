import type { IncomingMessage, ServerResponse } from "node:http";
import type { RssService } from "./service";
import { RssError } from "./store";

export async function handleRssRequest(req: IncomingMessage, res: ServerResponse, service: RssService) {
  const url = new URL(req.url || "/", "http://localhost");
  const operation = url.pathname.slice("/rss/".length);
  const send = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
  try {
    if (req.method === "GET") {
      const room = url.searchParams.get("room") || "";
      if (operation === "state") { send(200, await service.state(room)); return; }
      if (operation === "articles") { send(200, await service.articles(room, { feedId: url.searchParams.get("feedId") || undefined, id: url.searchParams.get("id") || undefined, unread: url.searchParams.get("unread") === "1", excluded: url.searchParams.get("excluded") === "1", offset: Number(url.searchParams.get("offset")), limit: Number(url.searchParams.get("limit")) })); return; }
      if (operation === "export") {
        const content = await service.opml(room);
        res.writeHead(200, { "Content-Type": "text/x-opml; charset=utf-8", "Content-Disposition": 'attachment; filename="cabinet-feeds.opml"', "Cache-Control": "no-store" });
        res.end(content); return;
      }
      throw new RssError("RSS route not found", 404);
    }
    if (req.method !== "POST") throw new RssError("Method not allowed", 405);
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 2 * 1024 * 1024) throw new RssError("Request too large", 413); chunks.push(bytes); }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    if (!input || typeof input.room !== "string") throw new RssError("Select a room");
    const room = input.room;
    if (operation === "action") { send(200, await service.act(room, input)); return; }
    if (!service.briefs) throw new RssError("AI briefs unavailable", 503);
    if (operation === "prepare") {
      if (typeof input.briefId !== "string" || typeof input.jobId !== "string" || typeof input.agentSlug !== "string" || input.scheduledAt !== undefined && (typeof input.scheduledAt !== "string" || !Number.isFinite(Date.parse(input.scheduledAt)))) throw new RssError("Invalid brief request");
      send(200, await service.briefs.prepare(room, input.briefId, input.jobId, input.agentSlug, input.scheduledAt as string | undefined, input.retryRunId === undefined ? undefined : String(input.retryRunId))); return;
    }
    if (typeof input.runId !== "string") throw new RssError("Invalid run");
    if (operation === "bind" && typeof input.conversationId === "string") { await service.briefs.bind(room, input.runId, input.conversationId); send(200, { ok: true }); return; }
    if (operation === "complete" && typeof input.status === "string" && typeof input.output === "string") { await service.briefs.complete(room, input.runId, input.status, input.output); send(200, { ok: true }); return; }
    throw new RssError("RSS route not found", 404);
  } catch (error) {
    send(error instanceof RssError ? error.status : error instanceof SyntaxError ? 400 : 500, { error: error instanceof RssError ? error.message : error instanceof SyntaxError ? "Invalid JSON" : "RSS request failed" });
  }
}
