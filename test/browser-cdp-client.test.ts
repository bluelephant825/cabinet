import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { CDPClient, PipeParser, encodeMessage } from "../server/browser/cdp-client";

function makePair() {
  // What the client writes -> chromium stdin (fd3); chromium stdout (fd4) -> client reads.
  const writable = new PassThrough();
  const readable = new PassThrough();
  const client = new CDPClient(writable, readable);
  const written: Buffer[] = [];
  writable.on("data", (chunk: Buffer) => written.push(chunk));
  return { client, writable, readable, written };
}

function parseWritten(chunks: Buffer[]): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  new PipeParser().push(Buffer.concat(chunks), (m) => messages.push(m));
  return messages;
}

test("PipeParser: message split across chunks", () => {
  const parser = new PipeParser();
  const received: Record<string, unknown>[] = [];
  const raw = encodeMessage({ id: 1, result: { ok: true } });
  parser.push(raw.subarray(0, 5), (m) => received.push(m));
  assert.equal(received.length, 0);
  parser.push(raw.subarray(5), (m) => received.push(m));
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], { id: 1, result: { ok: true } });
});

test("PipeParser: two messages in one chunk", () => {
  const parser = new PipeParser();
  const received: Record<string, unknown>[] = [];
  const raw = Buffer.concat([
    encodeMessage({ id: 1, result: {} }),
    encodeMessage({ method: "Target.targetCreated", params: { targetInfo: { targetId: "t1" } } }),
  ]);
  parser.push(raw, (m) => received.push(m));
  assert.equal(received.length, 2);
  assert.equal(received[1].method, "Target.targetCreated");
});

test("send resolves by id and rejects on error replies", async () => {
  const { client, readable, written } = makePair();
  const p1 = client.send("Browser.getVersion");
  const p2 = client.send("Target.getTargets");

  const sent = parseWritten(written);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].method, "Browser.getVersion");
  assert.equal(sent[1].method, "Target.getTargets");

  // Respond out of order.
  readable.write(encodeMessage({ id: sent[1].id as number, error: { message: "boom" } }));
  await assert.rejects(p2, /boom/);

  readable.write(encodeMessage({ id: sent[0].id as number, result: { product: "Chrome" } }));
  assert.deepEqual(await p1, { product: "Chrome" });
  client.close();
});

test("send carries sessionId; pending rejects on close", async () => {
  const { client, readable, written } = makePair();
  const pending = client.send("Page.navigate", { url: "https://x" }, "SESSION-1");
  const sent = parseWritten(written);
  assert.equal(sent[0].sessionId, "SESSION-1");

  readable.destroy();
  await assert.rejects(pending, /pipe/i);
  await assert.rejects(client.send("Page.reload"), /closed/i);
  client.close();
});

test("events dispatch with sessionId and method routing", async () => {
  const { client, readable } = makePair();
  const all: { method: string; sessionId?: string }[] = [];
  const nav: { method: string; sessionId?: string }[] = [];
  client.onEvent("*", (e) => all.push({ method: e.method, sessionId: e.sessionId }));
  client.onEvent("Page.frameNavigated", (e) => nav.push({ method: e.method, sessionId: e.sessionId }));

  readable.write(
    encodeMessage({
      method: "Page.frameNavigated",
      params: { frame: { id: "f1" } },
      sessionId: "S9",
    }),
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(all.length, 1);
  assert.equal(all[0].sessionId, "S9");
  assert.equal(nav.length, 1);
  client.close();
});
