import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";

import {
  ExtensionManager,
  crxZipOffset,
  deriveExtensionId,
  extractExtensionId,
  resolveI18nMessage,
} from "../server/browser/extension-manager";
import type { CDPClient } from "../server/browser/cdp-client";

const EXT_ID = "bcmnckabbmlnklolblobnobnlioneebd"; // 32 chars in [a-p]

function crx3(zipBytes: Buffer): Buffer {
  const headerSize = 4; // minimal fake header payload
  const out = Buffer.alloc(12 + headerSize);
  out.writeUInt32LE(0x34327243, 0); // Cr24
  out.writeUInt32LE(3, 4);
  out.writeUInt32LE(headerSize, 8);
  return Buffer.concat([out, zipBytes]);
}

function crx2(zipBytes: Buffer): Buffer {
  const pubKeyLen = 8;
  const sigLen = 4;
  const out = Buffer.alloc(16 + pubKeyLen + sigLen);
  out.writeUInt32LE(0x34327243, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(pubKeyLen, 8);
  out.writeUInt32LE(sigLen, 12);
  return Buffer.concat([out, zipBytes]);
}

async function extensionZip(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "manifest.json",
    JSON.stringify({
      manifest_version: 3,
      name: "__MSG_appName__",
      version: "1.2.3",
      description: "__MSG_appDesc__",
      default_locale: "en",
      icons: { "48": "icon.png" },
      content_scripts: [{ matches: ["https://example.com/*"] }],
      options_ui: { page: "options.html" },
      action: { default_popup: "popup.html" },
    }),
  );
  zip.file(
    "_locales/en/messages.json",
    JSON.stringify({
      AppName: { message: "Transcribed" },
      appDesc: { message: "Transcribe stuff" },
    }),
  );
  zip.file("icon.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  zip.file("popup.html", "<html></html>");
  zip.file("options.html", "<html></html>");
  return zip.generateAsync({ type: "nodebuffer" });
}

type CdpCall = { method: string; params?: Record<string, unknown> };
function fakeCdp(calls: CdpCall[]): CDPClient {
  return {
    send: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "Extensions.loadUnpacked") return { id: `runtime-${(params?.path as string)?.split("/").pop()}` };
      return {};
    },
  } as unknown as CDPClient;
}

function fakeFetch(zipBytes: Buffer): typeof fetch {
  return (async () =>
    new Response(new Uint8Array(crx3(zipBytes)), { status: 200 })) as unknown as typeof fetch;
}

function tmpUserData(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cabinet-ext-"));
  process.env.CABINET_USER_DATA = dir;
  return dir;
}

test("extractExtensionId accepts bare ids and web-store URLs", () => {
  assert.equal(extractExtensionId(EXT_ID), EXT_ID);
  assert.equal(
    extractExtensionId(`https://chromewebstore.google.com/detail/transcribed/${EXT_ID}?hl=en`),
    EXT_ID,
  );
  assert.equal(extractExtensionId("not-an-id"), null);
});

test("crxZipOffset handles crx2, crx3 and raw zip", () => {
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(crxZipOffset(zip), 0);
  const v3 = crx3(zip);
  assert.equal(crxZipOffset(v3), 16); // 12 + headerSize(4)
  const v2 = crx2(zip);
  assert.equal(crxZipOffset(v2), 28); // 16 + 8 + 4
  assert.throws(() => crxZipOffset(Buffer.alloc(4)), /no CRX data/i);
});

test("resolveI18nMessage resolves __MSG_ keys case-insensitively", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cabinet-i18n-"));
  fs.mkdirSync(path.join(dir, "_locales", "en"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "_locales", "en", "messages.json"),
    JSON.stringify({ AppName: { message: "Transcribed" } }),
  );
  const manifest = { default_locale: "en" };
  assert.equal(resolveI18nMessage("__MSG_appName__", dir, manifest), "Transcribed");
  assert.equal(resolveI18nMessage("__MSG_APPNAME__", dir, manifest), "Transcribed");
  assert.equal(resolveI18nMessage("__MSG_missing__", dir, manifest), "__MSG_missing__");
  assert.equal(resolveI18nMessage("plain", dir, manifest), "plain");
});

test("install unpacks, resolves i18n, loads unpacked and records runtimeId", async () => {
  const userData = tmpUserData();
  const calls: CdpCall[] = [];
  const mgr = new ExtensionManager({
    getCdp: () => fakeCdp(calls),
    fetchFn: fakeFetch(await extensionZip()),
  });
  const rec = await mgr.install(`https://chromewebstore.google.com/detail/x/${EXT_ID}`);
  assert.equal(rec.id, EXT_ID);
  assert.equal(rec.name, "Transcribed");
  assert.equal(rec.version, "1.2.3");
  assert.equal(rec.runtimeId, `runtime-${EXT_ID}`);
  assert.equal(rec.enabled, true);
  assert.deepEqual(rec.contentScriptMatches, ["https://example.com/*"]);
  assert.equal(rec.popupHtml, "popup.html");
  assert.equal(rec.optionsPage, "options.html");
  assert.ok(rec.iconDataUrl?.startsWith("data:image/png;base64,"));
  assert.ok(fs.existsSync(path.join(userData, "Browser", "Extensions", EXT_ID, "manifest.json")));
  assert.ok(calls.some((c) => c.method === "Extensions.loadUnpacked"));
  // State file written
  const state = JSON.parse(
    fs.readFileSync(path.join(userData, "Browser", "extensions.json"), "utf8"),
  );
  assert.equal(state.length, 1);
});

test("disable then enable issues Extensions.uninstall then loadUnpacked", async () => {
  tmpUserData();
  const calls: CdpCall[] = [];
  const mgr = new ExtensionManager({
    getCdp: () => fakeCdp(calls),
    fetchFn: fakeFetch(await extensionZip()),
  });
  await mgr.install(EXT_ID);
  calls.length = 0;

  const disabled = await mgr.disable(EXT_ID);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.runtimeId, null);
  assert.deepEqual(calls.map((c) => c.method), ["Extensions.uninstall"]);

  calls.length = 0;
  const enabled = await mgr.enable(EXT_ID);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.runtimeId, `runtime-${EXT_ID}`);
  assert.deepEqual(calls.map((c) => c.method), ["Extensions.loadUnpacked"]);
});

test("migrateLegacyRecords re-installs from cabinet-config.json and strips the key", async () => {
  const userData = tmpUserData();
  const calls: CdpCall[] = [];
  const mgr = new ExtensionManager({
    getCdp: () => fakeCdp(calls),
    fetchFn: fakeFetch(await extensionZip()),
  });
  // Legacy state: config lists the extension, old patched dir exists.
  fs.writeFileSync(
    path.join(userData, "cabinet-config.json"),
    JSON.stringify({ dataDir: "/x", extensions: [{ id: EXT_ID, enabled: false, pinned: true }] }),
  );
  const legacyDir = path.join(userData, "extensions", EXT_ID);
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "patched.js"), "// stub");

  await mgr.migrateLegacyRecords();

  const list = await mgr.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, EXT_ID);
  assert.equal(list[0].enabled, false); // preserved
  assert.equal(list[0].pinned, true);
  // enabled:false must route through disable() — the record was loaded into
  // the runtime by install() first, so Extensions.uninstall must follow.
  const methods = calls.map((c) => c.method);
  assert.ok(
    methods.indexOf("Extensions.loadUnpacked") < methods.indexOf("Extensions.uninstall"),
    `expected loadUnpacked before uninstall, got ${methods.join(",")}`,
  );
  assert.equal(list[0].runtimeId, null);
  assert.ok(!fs.existsSync(legacyDir)); // patched dir deleted
  const config = JSON.parse(fs.readFileSync(path.join(userData, "cabinet-config.json"), "utf8"));
  assert.equal(config.extensions, undefined);
  assert.equal(config.dataDir, "/x"); // other keys preserved

  // Second run is a no-op (extensions.json now exists).
  calls.length = 0;
  const mgr2 = new ExtensionManager({
    getCdp: () => fakeCdp(calls),
    fetchFn: fakeFetch(await extensionZip()),
  });
  await mgr2.migrateLegacyRecords();
  assert.equal((await mgr2.list()).length, 1);
});

test("crx2 install path works end-to-end", async () => {
  tmpUserData();
  const calls: CdpCall[] = [];
  const mgr = new ExtensionManager({
    getCdp: () => fakeCdp(calls),
    fetchFn: (async () =>
      new Response(new Uint8Array(crx2(await extensionZip())), { status: 200 })) as typeof fetch,
  });
  const rec = await mgr.install(EXT_ID);
  assert.equal(rec.name, "Transcribed");
  assert.ok(calls.some((c) => c.method === "Extensions.loadUnpacked"));
});

test("re-install of a disabled record skips loadUnpacked", async () => {
  tmpUserData();
  const calls: CdpCall[] = [];
  const mgr = new ExtensionManager({
    getCdp: () => fakeCdp(calls),
    fetchFn: fakeFetch(await extensionZip()),
  });
  await mgr.install(EXT_ID);
  await mgr.disable(EXT_ID);
  calls.length = 0;

  const rec = await mgr.install(EXT_ID);
  assert.equal(rec.enabled, false);
  assert.equal(rec.runtimeId, null);
  assert.ok(!calls.some((c) => c.method === "Extensions.loadUnpacked"));
});

function seedRecord(userData: string, runtimeId: string | null): string {
  const extDir = path.join(userData, "Browser", "Extensions", EXT_ID);
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(path.join(extDir, "manifest.json"), "{}");
  fs.writeFileSync(
    path.join(userData, "Browser", "extensions.json"),
    JSON.stringify([
      {
        id: EXT_ID,
        name: "Transcribed",
        version: "1.2.3",
        path: extDir,
        description: "",
        iconDataUrl: null,
        popupHtml: null,
        optionsPage: null,
        contentScriptMatches: [],
        enabled: true,
        pinned: false,
        runtimeId,
      },
    ]),
  );
  return extDir;
}

test("applyAll loadUnpacks every enabled record on each launch", async () => {
  const userData = tmpUserData();
  const calls: CdpCall[] = [];
  const mgr = new ExtensionManager({
    getCdp: () => fakeCdp(calls),
    fetchFn: fakeFetch(await extensionZip()),
  });
  // CDP-installed unpacked extensions are session-scoped: Chrome purges
  // their registration at exit, so a Secure Preferences entry left over
  // from a previous session is dead — applyAll must loadUnpacked again
  // (verified empirically: Chrome for Testing drops the extension instead
  // of re-attaching it).
  seedRecord(userData, null);

  await mgr.applyAll();

  const rec = (await mgr.list())[0];
  assert.equal(rec.runtimeId, `runtime-${EXT_ID}`);
  assert.ok(calls.some((c) => c.method === "Extensions.loadUnpacked"));
});

test("applyAll skips disabled records and clears their runtimeId", async () => {
  const userData = tmpUserData();
  const calls: CdpCall[] = [];
  const mgr = new ExtensionManager({
    getCdp: () => fakeCdp(calls),
    fetchFn: fakeFetch(await extensionZip()),
  });
  seedRecord(userData, `runtime-${EXT_ID}`);
  await mgr.disable(EXT_ID);
  calls.length = 0;

  await mgr.applyAll();

  const rec = (await mgr.list())[0];
  assert.equal(rec.runtimeId, null);
  assert.ok(!calls.some((c) => c.method === "Extensions.loadUnpacked"));
});

test("uninstall removes record and directory", async () => {
  const userData = tmpUserData();
  const calls: CdpCall[] = [];
  const mgr = new ExtensionManager({
    getCdp: () => fakeCdp(calls),
    fetchFn: fakeFetch(await extensionZip()),
  });
  await mgr.install(EXT_ID);
  await mgr.uninstall(EXT_ID);
  assert.equal((await mgr.list()).length, 0);
  assert.ok(!fs.existsSync(path.join(userData, "Browser", "Extensions", EXT_ID)));
  assert.ok(calls.some((c) => c.method === "Extensions.uninstall"));
});

function makeUnpackedDir(overrides?: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cabinet-ext-src-"));
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Dev Extension",
      version: "0.1.0",
      description: "loaded from disk",
      ...overrides,
    }),
  );
  fs.writeFileSync(path.join(dir, "sentinel.txt"), "user file, never delete");
  return dir;
}

test("deriveExtensionId produces a stable a-p id and honors manifest.key", () => {
  const dir = makeUnpackedDir();
  const id = deriveExtensionId(dir, { name: "x" });
  assert.match(id, /^[a-p]{32}$/);
  assert.equal(deriveExtensionId(dir, { name: "x" }), id); // deterministic
  const keyed = deriveExtensionId(dir, { name: "x", key: Buffer.from("k").toString("base64") });
  assert.match(keyed, /^[a-p]{32}$/);
  assert.notEqual(keyed, id); // key wins over path
});

test("installUnpacked loads the folder in place and marks the record", async () => {
  const userData = tmpUserData();
  const srcDir = makeUnpackedDir();
  const calls: CdpCall[] = [];
  const mgr = new ExtensionManager({
    getCdp: () => fakeCdp(calls),
    fetchFn: fakeFetch(await extensionZip()),
  });
  const rec = await mgr.installUnpacked(srcDir);
  assert.equal(rec.unpacked, true);
  assert.equal(rec.name, "Dev Extension");
  assert.equal(rec.version, "0.1.0");
  assert.equal(rec.path, srcDir); // kept in place, not copied into appdata
  assert.equal(rec.enabled, true);
  assert.equal(rec.runtimeId, `runtime-${path.basename(srcDir)}`);
  assert.ok(calls.some((c) => c.method === "Extensions.loadUnpacked" && c.params?.path === srcDir));
  // Nothing written under managed Extensions/<id> for unpacked records
  assert.ok(!fs.existsSync(path.join(userData, "Browser", "Extensions")));
});

test("installUnpacked works with the browser stopped (runtimeId null, derived id)", async () => {
  tmpUserData();
  const srcDir = makeUnpackedDir();
  const mgr = new ExtensionManager({ getCdp: () => null });
  const rec = await mgr.installUnpacked(srcDir);
  assert.equal(rec.runtimeId, null);
  assert.equal(rec.id, deriveExtensionId(srcDir, { name: "Dev Extension" }));
  assert.equal(rec.unpacked, true);
});

test("installUnpacked rejects non-folder, missing/invalid manifest", async () => {
  tmpUserData();
  const mgr = new ExtensionManager({ getCdp: () => null });

  await assert.rejects(() => mgr.installUnpacked("/no/such/dir-xyz"), /not a folder/i);

  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cabinet-ext-")), "f.txt");
  fs.writeFileSync(filePath, "x");
  await assert.rejects(() => mgr.installUnpacked(filePath), /not a folder/i);

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "cabinet-ext-src-"));
  await assert.rejects(() => mgr.installUnpacked(empty), /manifest\.json/i);

  const badJson = fs.mkdtempSync(path.join(os.tmpdir(), "cabinet-ext-src-"));
  fs.writeFileSync(path.join(badJson, "manifest.json"), "{nope");
  await assert.rejects(() => mgr.installUnpacked(badJson), /not valid JSON/i);

  const noName = fs.mkdtempSync(path.join(os.tmpdir(), "cabinet-ext-src-"));
  fs.writeFileSync(
    path.join(noName, "manifest.json"),
    JSON.stringify({ manifest_version: 3, version: "1.0" }),
  );
  await assert.rejects(() => mgr.installUnpacked(noName), /manifest_version, name/i);
});

test("installUnpacked is idempotent for the same folder and keeps prefs", async () => {
  tmpUserData();
  const srcDir = makeUnpackedDir({ version: "0.2.0" });
  const calls: CdpCall[] = [];
  const mgr = new ExtensionManager({
    getCdp: () => fakeCdp(calls),
    fetchFn: fakeFetch(await extensionZip()),
  });
  const first = await mgr.installUnpacked(srcDir);
  await mgr.setPinned(first.id, true);
  await mgr.disable(first.id);
  calls.length = 0;

  const second = await mgr.installUnpacked(srcDir);
  assert.equal((await mgr.list()).length, 1);
  assert.equal(second.id, first.id);
  assert.equal(second.pinned, true); // preserved across re-load
  assert.equal(second.enabled, false); // preserved — disabled ext is not re-loaded
  assert.equal(second.version, "0.2.0"); // metadata refreshed
  assert.ok(!calls.some((c) => c.method === "Extensions.loadUnpacked"));
});

test("uninstall of an unpacked record keeps the user's folder on disk", async () => {
  tmpUserData();
  const srcDir = makeUnpackedDir();
  const calls: CdpCall[] = [];
  const mgr = new ExtensionManager({
    getCdp: () => fakeCdp(calls),
    fetchFn: fakeFetch(await extensionZip()),
  });
  const rec = await mgr.installUnpacked(srcDir);
  await mgr.uninstall(rec.id);
  assert.equal((await mgr.list()).length, 0);
  assert.ok(fs.existsSync(path.join(srcDir, "manifest.json")));
  assert.ok(fs.existsSync(path.join(srcDir, "sentinel.txt")));
  assert.ok(calls.some((c) => c.method === "Extensions.uninstall"));
});

test("installUnpacked surfaces CDP errors without leaking the path", async () => {
  tmpUserData();
  const srcDir = makeUnpackedDir();
  const mgr = new ExtensionManager({
    getCdp: () =>
      ({
        send: async () => {
          throw new Error(`Cannot load extension at ${srcDir}: bad manifest`);
        },
      }) as unknown as CDPClient,
  });
  const err = await mgr.installUnpacked(srcDir).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.match(err.message, /bad manifest/i);
  assert.ok(!err.message.includes(srcDir), "error must not leak the absolute path");
});
