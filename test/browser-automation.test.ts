import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserAutomationService } from "../server/browser/automation-service";
import type { CdpEventMessage } from "../server/browser/cdp-client";

const TOOLS = ["manage_tabs", "page_click", "page_type", "page_select", "get_text", "page_navigate", "page_press_keys", "page_wait_for"];

class FakeCdp {
  handlers = new Map<string, (event: CdpEventMessage) => void>();

  async send(method: string): Promise<unknown> {
    if (method === "Target.attachToBrowserTarget") return { sessionId: "ROOT" };
    if (method === "Target.detachFromTarget") return {};
    return {};
  }

  claimIsolatedSession(id: string, handler: (event: CdpEventMessage) => void) {
    this.handlers.set(id, handler);
  }

  releaseIsolatedSession(id: string) {
    this.handlers.delete(id);
  }
}

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cabinet-automation-"));
  const log = path.join(root, "calls.jsonl");
  const server = path.join(root, "fake-mcp.cjs");
  const executable = path.join(root, "alohajet");
  await fsp.writeFile(server, `
const readline = require("node:readline");
const fs = require("node:fs");
const tools = ${JSON.stringify(TOOLS)};
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") return send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "alohajet", version: "0.4.4" } } });
  if (request.method === "ping") return send({ jsonrpc: "2.0", id: request.id, result: {} });
  if (request.method === "tools/list") return send({ jsonrpc: "2.0", id: request.id, result: { tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })) } });
  if (request.method === "tools/call") {
    fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(request.params) + "\\n");
    return send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: request.params.name }], isError: false } });
  }
});
`);
  await fsp.writeFile(executable, `#!/bin/sh\nexec "${process.execPath}" "${server}"\n`, { mode: 0o755 });
  return { root, log, executable };
}

test("automation sessions select explicit tabs and close with the run", async () => {
  const files = await fixture();
  const cdp = new FakeCdp();
  const manager = {
    executable: async () => files.executable,
    childEnvironment: () => ({ PATH: process.env.PATH ?? "", FAKE_LOG: files.log }),
    updateSettings: async () => ({ enabled: true, maxObservationTokens: 8000, compactTools: false }),
    status: async () => ({ enabled: true }),
  };
  const service = new BrowserAutomationService({
    manager,
    ensureBrowser: async () => {},
    getCdp: () => cdp as never,
    idleMs: 60_000,
  });

  await assert.rejects(service.call("missing", "browser_read", { tabId: "T1" }), /not active/);
  service.registerRun({ runId: "run-1", agentSlug: "researcher", cabinetPath: "room" });
  const result = await service.call("run-1", "browser_click", { tabId: "T1", alohaId: "abc" });
  assert.equal((result.content[0] as { text: string }).text, "page_click");

  const calls = (await fsp.readFile(files.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls.map((entry) => entry.name), ["manage_tabs", "page_click"]);
  assert.deepEqual(calls[0].arguments, { action: "use", tab_id: "T1" });
  assert.deepEqual(calls[1].arguments, { aloha_id: "abc" });

  await service.releaseRun("run-1");
  assert.equal(cdp.handlers.size, 0);
  await fsp.rm(files.root, { recursive: true, force: true });
});
