import type { IncomingMessage, ServerResponse } from "node:http";
import type { InboxWatcher } from "./inbox";

/** Called only after the daemon's existing token/origin authorization. */
export async function handleInboxRequest(req: IncomingMessage, res: ServerResponse, inbox: InboxWatcher): Promise<void> {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET") { send(200, inbox.status()); return; }
  if (req.method !== "POST") { send(405, { error: "Method not allowed" }); return; }
  try {
    let body = "";
    for await (const chunk of req) {
      body += chunk.toString();
      if (Buffer.byteLength(body) > 4096) { send(413, { error: "Request too large" }); return; }
    }
    const input = JSON.parse(body);
    if (input?.action === "ingest-all") { send(202, await inbox.ingestAll()); return; }
    if (input?.action === "set-automatic" && typeof input.enabled === "boolean") {
      send(200, await inbox.setAutomatic(input.enabled)); return;
    }
    send(400, { error: "Invalid Inbox action" });
  } catch (error) {
    send(error instanceof SyntaxError ? 400 : 409, { error: error instanceof Error ? error.message : String(error) });
  }
}
