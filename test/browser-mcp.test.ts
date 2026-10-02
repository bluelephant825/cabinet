import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

function responseQueue(stream: NodeJS.ReadableStream) {
  const waiting: Array<(value: Record<string, unknown>) => void> = [];
  const messages: Record<string, unknown>[] = [];
  readline.createInterface({ input: stream }).on("line", (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    const next = waiting.shift();
    if (next) next(message);
    else messages.push(message);
  });
  return () => new Promise<Record<string, unknown>>((resolve) => {
    const message = messages.shift();
    if (message) resolve(message);
    else waiting.push(resolve);
  });
}

test("cabinet-browser MCP lists tools without side effects and proxies calls", { timeout: 30_000 }, async () => {
  const calls: Record<string, unknown>[] = [];
  const daemon = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    calls.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ content: [{ type: "text", text: "ok" }], isError: false }));
  });
  await new Promise<void>((resolve) => daemon.listen(0, "127.0.0.1", resolve));
  const port = (daemon.address() as { port: number }).port;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const child = spawn(process.execPath, [
    path.join(root, "node_modules/tsx/dist/cli.mjs"),
    "--tsconfig",
    path.join(root, "tsconfig.json"),
    path.join(root, "scripts/browser-tool.ts"),
    "mcp",
  ], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      CABINET_DAEMON_URL: `http://127.0.0.1:${port}`,
      CABINET_DAEMON_TOKEN: "mcp-test-token",
      CABINET_RUN_ID: "run-mcp",
    },
  });
  const next = responseQueue(child.stdout);
  const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(message)}\n`);

  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  assert.equal((await next()).id, 1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const listed = await next();
  assert.equal(listed.id, 2);
  assert.equal(calls.length, 0);
  const names = ((listed.result as { tools: { name: string }[] }).tools).map((tool) => tool.name);
  assert.ok(names.includes("browser_read"));
  assert.ok(names.includes("browser_import_pdf"));

  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_read", arguments: { tabId: "T1" } } });
  const called = await next();
  assert.equal(called.id, 3);
  assert.equal(((called.result as { content: { text: string }[] }).content[0]).text, "ok");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authorization, "Bearer mcp-test-token");
  assert.deepEqual(calls[0].body, { runId: "run-mcp", name: "browser_read", arguments: { tabId: "T1" } });

  child.stdin.end();
  await new Promise<void>((resolve, reject) => {
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`MCP exited ${code}`)));
  });
  await new Promise<void>((resolve) => daemon.close(() => resolve()));
});
