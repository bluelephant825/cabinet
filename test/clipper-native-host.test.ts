import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";

const bridge = createRequire(import.meta.url)("../launcher/clipper-native-host.cjs");

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-clipper-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("registers the same allowlisted bridge for external Chrome and Cabinet Chromium", async (t) => {
  const root = await fixture(t);
  const userDataDir = path.join(root, "Cabinet");
  const manifests = await bridge.registerNativeHost({ homeDir: root, userDataDir, nodePath: "/bundle/bin/node", hostScript: "/bundle/server/clipper-native-host.cjs", launcherPath: "/bundle/Cabinet", platform: "darwin" });
  assert.ok(manifests.includes(path.join(root, "Library/Application Support/Google/Chrome/NativeMessagingHosts/ai.cabinet.clipper.json")));
  assert.ok(manifests.includes(path.join(userDataDir, "Browser/Profile/NativeMessagingHosts/ai.cabinet.clipper.json")));
  for (const file of manifests) {
    const manifest = JSON.parse(await fs.readFile(file, "utf8"));
    assert.deepEqual(manifest.allowed_origins, ["chrome-extension://bbddlgefpahcbpcaikiacdpghikifabf/"]);
    assert.equal(manifest.type, "stdio");
    assert.ok((await fs.stat(manifest.path)).mode & 0o100);
  }
});

test("discovers a changed app port without relying on browser tabs or a cached port", async (t) => {
  const root = await fixture(t);
  const config = path.join(root, "cabinet-config.json");
  const urls: string[] = [];
  const fetchImpl = async (url: string) => {
    urls.push(url);
    return { ok: true, json: async () => ({ status: "ok", dataDir: "/fixture", installKind: "chromium-macos", stale: false }) };
  };
  const launch = () => assert.fail("a running app must not be launched again");
  await fs.writeFile(config, JSON.stringify({ appPort: 54321 }));
  assert.equal((await bridge.discoverCabinet({ userDataDir: root, fetchImpl, launch })).apiUrl, "http://127.0.0.1:54321");
  await fs.writeFile(config, JSON.stringify({ appPort: 54322 }));
  assert.equal((await bridge.discoverCabinet({ userDataDir: root, fetchImpl, launch })).apiUrl, "http://127.0.0.1:54322");
  assert.deepEqual(urls, ["http://127.0.0.1:54321/api/health", "http://127.0.0.1:54322/api/health"]);
});

test("cold start launches Cabinet once and waits for its current healthy origin", async (t) => {
  const root = await fixture(t);
  let launches = 0;
  const result = await bridge.discoverCabinet({
    userDataDir: root, pollMs: 1, deadlineMs: 1000,
    launch: async () => { launches++; await fs.writeFile(path.join(root, "cabinet-config.json"), JSON.stringify({ appPort: 54323 })); },
    fetchImpl: async () => ({ ok: true, json: async () => ({ status: "ok", dataDir: "/fixture", installKind: "chromium-macos" }) }),
  });
  assert.equal(launches, 1);
  assert.equal(result.apiUrl, "http://127.0.0.1:54323");
});

test("rejects unrelated or stale health responses and stops at its deadline", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, "cabinet-config.json"), JSON.stringify({ appPort: 54321 }));
  for (const health of [{ status: "ok" }, { status: "ok", dataDir: "/fixture", installKind: "desktop", stale: true }]) {
    const result = await bridge.discoverCabinet({ userDataDir: root, launch: () => {}, pollMs: 1, deadlineMs: 5, fetchImpl: async () => ({ ok: true, json: async () => health }) });
    assert.equal(result.success, false);
    assert.equal(result.apiUrl, undefined);
  }
});

test("native framing handles fragmented UTF-8 input and produces only framed JSON", async () => {
  const input = new PassThrough();
  const pending = bridge.readNativeMessage(input);
  const frame = bridge.encodeNativeMessage({ action: "discover", version: 1, label: "é" });
  for (const byte of frame) input.write(Buffer.from([byte]));
  assert.deepEqual(await pending, { action: "discover", version: 1, label: "é" });
});

test("rejects oversized and truncated native messages", async () => {
  const oversized = new PassThrough();
  const rejection = assert.rejects(bridge.readNativeMessage(oversized));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(8193);
  oversized.end(header);
  await rejection;
  const truncated = new PassThrough();
  const secondRejection = assert.rejects(bridge.readNativeMessage(truncated));
  truncated.end(Buffer.from([10, 0, 0, 0, 123]));
  await secondRejection;
});

test("unknown actions never launch Cabinet or expose local configuration", async () => {
  const response = await bridge.handleNativeRequest({ action: "readFile", path: "/anything" }, { launch: () => assert.fail("must not launch") });
  assert.deepEqual(response, { success: false, error: "Unsupported native bridge request." });
});

async function nativeProcess(userDataDir: string, origin: string) {
  const entry = process.env.CABINET_NATIVE_HOST_ENTRY || fileURLToPath(new URL("../launcher/clipper-native-host.cjs", import.meta.url));
  const node = process.env.CABINET_NATIVE_HOST_NODE || process.execPath;
  const child = spawn(node, [entry, "--user-data-dir", userDataDir, "--launcher", path.join(userDataDir, "unused-launcher"), origin], { stdio: ["pipe", "pipe", "pipe"] });
  let output = Buffer.alloc(0);
  let error = "";
  child.stdout.on("data", (chunk: Buffer) => { output = Buffer.concat([output, chunk]); });
  child.stderr.on("data", chunk => { error += String(chunk); });
  const completion = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(`Native host exited: ${code}`)));
  });
  child.stdin.end(bridge.encodeNativeMessage({ action: "discover", version: 1 }));
  await completion;
  assert.equal(error, "");
  assert.equal(output.readUInt32LE(0), output.length - 4);
  return JSON.parse(output.subarray(4).toString("utf8"));
}

test("real native process discovers a loopback fixture over framed stdin/stdout", async (t) => {
  const root = await fixture(t);
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "ok", dataDir: root, installKind: "chromium-macos", stale: false }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await fs.writeFile(path.join(root, "cabinet-config.json"), JSON.stringify({ appPort: address.port }));
  const response = await nativeProcess(root, bridge.EXTENSION_ORIGIN);
  assert.equal(response.success, true);
  assert.equal(response.apiUrl, `http://127.0.0.1:${address.port}`);
});

test("real native process rejects an extension outside the allowlist", async (t) => {
  const root = await fixture(t);
  const response = await nativeProcess(root, "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/");
  assert.equal(response.success, false);
  assert.equal(response.apiUrl, undefined);
});
