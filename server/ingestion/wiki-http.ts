import type { IncomingMessage, ServerResponse } from "node:http";
import type { WikiWorkflow } from "./wiki-workflow";

/** Daemon token/origin checks run before this handler. */
export async function handleWikiRequest(req: IncomingMessage, res: ServerResponse, workflow: WikiWorkflow) {
  const send = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); };
  try {
    if (req.method === "GET") { send(200, await workflow.status()); return; }
    if (req.method !== "POST") { send(405, { error: "Method not allowed" }); return; }
    let bytes = 0; const chunks: Buffer[] = [];
    for await (const chunk of req) {
      const buffer = Buffer.from(chunk); bytes += buffer.length;
      if (bytes > 128 * 1024) { send(413, { error: "Selection is too large" }); return; }
      chunks.push(buffer);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid Wiki request");
    send(200, await workflow.action(input));
  } catch (error) { send(409, { error: error instanceof Error ? error.message : String(error) }); }
}
