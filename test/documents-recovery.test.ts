import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsm from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { DATA_DIR, CABINET_INTERNAL_DIR } from "../src/lib/storage/path-utils";
import { buildBlankDocx } from "../src/vendor/genoffice/packages/docx-engine/src/blank";
import { DocumentService } from "../server/documents/service";
import { DocumentBroker } from "../server/documents/broker";
import { DocumentError } from "../src/lib/documents/errors";
import {
  listRecovery,
  readRecoveryBlob,
  evictIfNeeded,
  saveDraft,
  clearDraft,
  noteSessionOpened,
  noteSessionClosed,
  resetRecoverySessions,
} from "../server/documents/recovery";
import { revisionOf } from "../src/lib/documents/revision";
import JSZip from "jszip";

/** Blank docx is deterministic — inject a marker part to get distinct bytes. */
async function variantDocx(tag: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await buildBlankDocx());
  zip.file(`docProps/${tag}.xml`, `<marker tag="${tag}"/>`);
  return zip.generateAsync({ type: "uint8array" });
}

const services: DocumentService[] = [];
function makeService(): DocumentService {
  const s = new DocumentService(new DocumentBroker({ concurrency: 1 }));
  services.push(s);
  return s;
}
test.beforeEach(() => resetRecoverySessions());
test.after(async () => {
  for (const s of services) await s.shutdown();
});

function recoveryDir(absPath: string): string {
  const key = createHash("sha256").update(absPath).digest("hex").slice(0, 32);
  return path.join(CABINET_INTERNAL_DIR, "documents", "recovery", key);
}

async function writeDoc(rel: string, bytes: Uint8Array): Promise<string> {
  const abs = path.join(DATA_DIR, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, bytes);
  return abs;
}

async function saveOver(
  svc: DocumentService,
  virtualPath: string,
  absPath: string,
  newBytes: Uint8Array,
): Promise<void> {
  const { tempPath } = await svc.prepareSaveTarget(virtualPath);
  await fs.writeFile(tempPath, newBytes);
  const current = revisionOf(await fs.readFile(absPath));
  await svc.save({ virtualPath, baseRevision: current, tempPath });
}

// ── tests ─────────────────────────────────────────────────────────────────

test("first session commit: baseline+previous share a blob; second commit replaces previous", async () => {
  const svc = makeService();
  const v0 = await variantDocx("v0");
  const v1 = await variantDocx("v1");
  const v2 = await variantDocx("v2");
  const abs = await writeDoc("rec/a.docx", v0);
  const real = await fsm.promises.realpath(abs);
  const opened = await svc.open({ virtualPath: "rec/a.docx" });

  await saveOver(svc, "rec/a.docx", abs, v1);
  let listed = await listRecovery(real);
  const baseline = listed.entries.find((e) => e.kind === "baseline");
  const previous = listed.entries.find((e) => e.kind === "previous");
  assert.ok(baseline && previous);
  assert.equal(baseline.revision, revisionOf(v0));
  assert.equal(previous.revision, revisionOf(v0));
  assert.equal(baseline.sessionId, opened.sessionId);

  // Same revision → one blob only.
  const dir = recoveryDir(real);
  const blobs = (await fs.readdir(dir)).filter((f) => f.endsWith(".bin") && f !== "draft.bin");
  assert.equal(blobs.length, 1);

  await saveOver(svc, "rec/a.docx", abs, v2);
  listed = await listRecovery(real);
  const previous2 = listed.entries.find((e) => e.kind === "previous");
  assert.equal(previous2?.revision, revisionOf(v1));
  // v0 blob stays — the session baseline still references it.
  assert.deepEqual(await readRecoveryBlob(real, revisionOf(v0)), Buffer.from(v0));
  assert.deepEqual(await readRecoveryBlob(real, revisionOf(v1)), Buffer.from(v1));
});

test("recovery copy failure → storage, target intact, no tmp/manifest", async () => {
  const svc = makeService();
  const v0 = await variantDocx("b0");
  const abs = await writeDoc("rec/b.docx", v0);
  const dir = recoveryDir(await fsm.promises.realpath(abs));

  const patched = fsm.promises as unknown as { copyFile: typeof fsm.promises.copyFile };
  const restore = patched.copyFile;
  // Fail only the recovery-blob copy (a `.bin` destination), not the commit's
  // own sibling-temp copyFile.
  patched.copyFile = (async (...args: Parameters<typeof fsm.promises.copyFile>) => {
    if (String(args[1]).endsWith(".bin")) {
      const e = new Error("ENOSPC: no space left on device") as NodeJS.ErrnoException;
      e.code = "ENOSPC";
      throw e;
    }
    return restore.apply(fsm.promises, args);
  }) as typeof fsm.promises.copyFile;
  try {
    const { tempPath } = await svc.prepareSaveTarget("rec/b.docx");
    const v1 = await variantDocx("b1");
    await fs.writeFile(tempPath, v1);
    await assert.rejects(
      svc.save({ virtualPath: "rec/b.docx", baseRevision: revisionOf(v0), tempPath }),
      (e) => e instanceof DocumentError && e.code === "storage",
    );
  } finally {
    patched.copyFile = restore;
  }
  assert.deepEqual(await fs.readFile(abs), Buffer.from(v0));
  const leftovers = (await fs.readdir(path.dirname(abs))).filter(
    (f) => f.endsWith(".tmp") || f.endsWith(".docwork"),
  );
  assert.deepEqual(leftovers, []);
  assert.equal(await fsm.promises.stat(path.join(dir, "manifest.json")).then(() => true).catch(() => false), false);
});

test("rename failure after copy → entry flagged protected, survives eviction", async () => {
  const svc = makeService();
  const v0 = await variantDocx("c0");
  const abs = await writeDoc("rec/c.docx", v0);
  const absPath = await fsm.promises.realpath(abs);

  const patched = fsm.promises as unknown as { rename: typeof fsm.promises.rename };
  const restore = patched.rename;
  patched.rename = (async () => {
    throw new Error("simulated rename crash");
  }) as typeof fsm.promises.rename;
  try {
    const { tempPath } = await svc.prepareSaveTarget("rec/c.docx");
    const v1 = await variantDocx("c1");
    await fs.writeFile(tempPath, v1);
    await assert.rejects(
      svc.save({ virtualPath: "rec/c.docx", baseRevision: revisionOf(v0), tempPath }),
      /simulated rename crash/,
    );
  } finally {
    patched.rename = restore;
  }
  const listed = await listRecovery(absPath);
  const previous = listed.entries.find((e) => e.kind === "previous");
  assert.equal(previous?.protected, true);

  // Eviction must not remove it.
  process.env.CABINET_DOC_RECOVERY_MAX_MB = "0.00001";
  try {
    await evictIfNeeded();
  } finally {
    delete process.env.CABINET_DOC_RECOVERY_MAX_MB;
  }
  const after = await listRecovery(absPath);
  assert.ok(after.entries.some((e) => e.protected));
  assert.deepEqual(await readRecoveryBlob(absPath, revisionOf(v0)), Buffer.from(v0));
});

test("eviction: oldest closed-session entries first; open baseline + protected + fresh draft survive", async () => {
  const svc = makeService();
  const v = await variantDocx("ev");

  // Path A: closed session, old entries.
  const absA = await writeDoc("rec/evict-a.docx", v);
  const realA = await fsm.promises.realpath(absA);
  const sA = await svc.open({ virtualPath: "rec/evict-a.docx" });
  await saveOver(svc, "rec/evict-a.docx", absA, await variantDocx("ev-a1"));
  svc.close(sA.sessionId);
  // Give it a clearly-old timestamp.
  const dirA = recoveryDir(realA);
  const mA = JSON.parse(await fs.readFile(path.join(dirA, "manifest.json"), "utf-8"));
  for (const e of mA.entries) e.createdAt = "2020-01-01T00:00:00.000Z";
  await fs.writeFile(path.join(dirA, "manifest.json"), JSON.stringify(mA));

  // Path B: open session baseline.
  const absB = await writeDoc("rec/evict-b.docx", v);
  const realB = await fsm.promises.realpath(absB);
  await svc.open({ virtualPath: "rec/evict-b.docx" });
  await saveOver(svc, "rec/evict-b.docx", absB, await variantDocx("ev-b1"));

  // Path C: protected entry.
  const absC = await writeDoc("rec/evict-c.docx", v);
  const realC = await fsm.promises.realpath(absC);
  const dirC = recoveryDir(realC);
  await fs.mkdir(dirC, { recursive: true });
  const protRev = revisionOf(v);
  await fs.copyFile(absC, path.join(dirC, `${protRev.slice(7)}.bin`));
  await fs.writeFile(
    path.join(dirC, "manifest.json"),
    JSON.stringify({
      version: 1,
      virtualPath: "rec/evict-c.docx",
      absPath: realC,
      entries: [
        { kind: "previous", revision: protRev, size: v.byteLength, createdAt: "2020-01-01T00:00:00.000Z", protected: true },
      ],
    }),
  );

  // Path D: fresh draft.
  const absD = await writeDoc("rec/evict-d.docx", v);
  const realD = await fsm.promises.realpath(absD);
  const draftTmp = path.join(DATA_DIR, "rec/.draft-stage.tmp");
  await fs.writeFile(draftTmp, v);
  await saveDraft({ absPath: realD, virtualPath: "rec/evict-d.docx", tempPath: draftTmp });

  process.env.CABINET_DOC_RECOVERY_MAX_MB = "0.00001";
  try {
    await evictIfNeeded();
  } finally {
    delete process.env.CABINET_DOC_RECOVERY_MAX_MB;
  }

  const listA = await listRecovery(realA);
  const listB = await listRecovery(realB);
  const listC = await listRecovery(realC);
  const listD = await listRecovery(realD);
  assert.equal(listA.entries.length, 0, "closed-session entries should be evicted");
  assert.ok(listB.entries.length > 0, "open-session entries must survive");
  assert.ok(listC.entries.some((e) => e.protected), "protected entries must survive");
  assert.ok(listD.draft, "fresh draft must survive");
});

test("draft save/clear; oversized draft → too-large, no file", async () => {
  const v = await variantDocx("d0");
  const abs = await writeDoc("rec/draft.docx", v);
  const real = await fsm.promises.realpath(abs);

  const tmp1 = path.join(DATA_DIR, "rec/.d1.tmp");
  await fs.writeFile(tmp1, v);
  const d = await saveDraft({ absPath: real, virtualPath: "rec/draft.docx", tempPath: tmp1 });
  assert.equal(d.revision, revisionOf(v));
  const listed = await listRecovery(real);
  assert.equal(listed.draft?.revision, revisionOf(v));

  await clearDraft(real);
  assert.equal((await listRecovery(real)).draft, undefined);

  process.env.CABINET_DOC_MAX_BYTES = "16";
  try {
    const tmp2 = path.join(DATA_DIR, "rec/.d2.tmp");
    await fs.writeFile(tmp2, v);
    await assert.rejects(
      saveDraft({ absPath: real, virtualPath: "rec/draft.docx", tempPath: tmp2 }),
      (e) => e instanceof DocumentError && e.code === "too-large",
    );
    assert.equal(await fsm.promises.stat(path.join(recoveryDir(real), "draft.bin")).then(() => true).catch(() => false), false);
  } finally {
    delete process.env.CABINET_DOC_MAX_BYTES;
  }
});

test("restoreRecovery round-trip advances revision; stale baseRevision → conflict", async () => {
  const svc = makeService();
  const v0 = await variantDocx("r0");
  const v1 = await variantDocx("r1");
  const abs = await writeDoc("rec/restore.docx", v0);
  const opened = await svc.open({ virtualPath: "rec/restore.docx" });
  void opened;

  await saveOver(svc, "rec/restore.docx", abs, v1);
  const stale = revisionOf(await variantDocx("stale"));
  await assert.rejects(
    svc.restoreRecovery({
      virtualPath: "rec/restore.docx",
      revision: revisionOf(v0),
      baseRevision: stale,
    }),
    (e) => e instanceof DocumentError && e.code === "conflict",
  );
  assert.deepEqual(await fs.readFile(abs), Buffer.from(v1));

  const current = (await svc.revision("rec/restore.docx")).revision;
  const restored = await svc.restoreRecovery({
    virtualPath: "rec/restore.docx",
    revision: revisionOf(v0),
    baseRevision: current,
  });
  assert.equal(restored.revision, revisionOf(v0));
  assert.deepEqual(await fs.readFile(abs), Buffer.from(v0));
});

test("noteSessionClosed downgrades the session baseline", async () => {
  const v = await variantDocx("x0");
  const abs = await writeDoc("rec/close.docx", v);
  const real = await fsm.promises.realpath(abs);
  noteSessionOpened(real, "sess-1");
  const dir = recoveryDir(real);
  await fs.mkdir(dir, { recursive: true });
  const rev = revisionOf(v);
  await fs.copyFile(abs, path.join(dir, `${rev.slice(7)}.bin`));
  await fs.writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      version: 1,
      virtualPath: "rec/close.docx",
      absPath: real,
      entries: [
        { kind: "baseline", revision: rev, size: v.byteLength, createdAt: new Date().toISOString(), sessionId: "sess-1" },
      ],
    }),
  );
  await noteSessionClosed(real, "sess-1");
  const listed = await listRecovery(real);
  const baseline = listed.entries.find((e) => e.kind === "baseline");
  assert.ok(baseline);
  assert.equal(baseline.sessionId, undefined);
});
