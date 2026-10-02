import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { AlohaJetManager, tarEntries } from "../server/browser/alohajet-manager";

function tar(files: Record<string, Buffer | string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, input] of Object.entries(files)) {
    const body = Buffer.isBuffer(input) ? input : Buffer.from(input);
    const header = Buffer.alloc(512);
    header.write(`release/${name}`, 0, 100, "utf8");
    header.write("0000755\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write("ustar\0", 257, 6, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

async function tempPaths() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cabinet-alohajet-"));
  return {
    root,
    installDir: path.join(root, "install"),
    settingsPath: path.join(root, ".devin", "browser-automation.json"),
  };
}

test("tar extraction accepts only required regular files", () => {
  const archive = tar({
    alohajet: "binary",
    LICENSE: "license",
    "THIRD-PARTY-NOTICES": "notices",
    "ignored.txt": "ignored",
  });
  const entries = tarEntries(archive);
  assert.deepEqual([...entries.keys()].sort(), ["LICENSE", "THIRD-PARTY-NOTICES", "alohajet"]);
  assert.equal(entries.get("alohajet")?.toString(), "binary");
});

test("status does not install and unsupported platforms fail explicitly", async () => {
  const paths = await tempPaths();
  let fetches = 0;
  const manager = new AlohaJetManager({
    ...paths,
    platform: "win32",
    arch: "x64",
    fetchImpl: async () => {
      fetches += 1;
      return new Response();
    },
  });
  const status = await manager.status();
  assert.equal(status.enabled, false);
  assert.equal(status.installed, false);
  assert.equal(status.supported, false);
  assert.equal(fetches, 0);
  await assert.rejects(manager.updateSettings({ enabled: true }), /not available/);
  assert.equal(fetches, 0);
  await fsp.rm(paths.root, { recursive: true, force: true });
});

test("enable performs one checksum-verified atomic installation", async () => {
  const paths = await tempPaths();
  const archive = tar({
    alohajet: "#!/bin/sh\necho 'alohajet 0.4.4'\n",
    LICENSE: "license",
    "THIRD-PARTY-NOTICES": "notices",
  });
  let fetches = 0;
  const manager = new AlohaJetManager({
    ...paths,
    platform: "darwin",
    arch: "arm64",
    release: {
      url: "https://example.test/alohajet.tar.gz",
      sha256: createHash("sha256").update(archive).digest("hex"),
    },
    fetchImpl: async () => {
      fetches += 1;
      return new Response(new Uint8Array(archive), { status: 200 });
    },
  });
  await Promise.all([
    manager.updateSettings({ enabled: true }),
    manager.updateSettings({ enabled: true, compactTools: true }),
  ]);
  assert.equal(fetches, 1);
  assert.equal((await manager.status()).installed, true);
  assert.match(await fsp.readFile(path.join(paths.installDir, "LICENSE"), "utf8"), /license/);
  assert.equal(manager.readSettings().enabled, true);
  await fsp.rm(paths.root, { recursive: true, force: true });
});

test("checksum mismatch leaves automation disabled", async () => {
  const paths = await tempPaths();
  const archive = tar({
    alohajet: "#!/bin/sh\necho 'alohajet 0.4.4'\n",
    LICENSE: "license",
    "THIRD-PARTY-NOTICES": "notices",
  });
  const manager = new AlohaJetManager({
    ...paths,
    platform: "darwin",
    arch: "arm64",
    release: { url: "https://example.test/bad.tar.gz", sha256: "0".repeat(64) },
    fetchImpl: async () => new Response(new Uint8Array(archive), { status: 200 }),
  });
  await assert.rejects(manager.updateSettings({ enabled: true }), /checksum mismatch/);
  assert.equal(manager.readSettings().enabled, false);
  assert.equal((await manager.status()).installed, false);
  await fsp.rm(paths.root, { recursive: true, force: true });
});
