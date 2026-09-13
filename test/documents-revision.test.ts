import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsm from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import simpleGit from "simple-git";

import { DATA_DIR } from "../src/lib/storage/path-utils";
import { buildBlankDocx } from "../src/vendor/genoffice/packages/docx-engine/src/blank";
import JSZip from "jszip";

/** Blank docx is deterministic — inject a marker part to get distinct bytes. */
async function variantDocx(tag: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await buildBlankDocx());
  zip.file(`docProps/${tag}.xml`, `<marker tag="${tag}"/>`);
  return zip.generateAsync({ type: "uint8array" });
}
import { DocumentService } from "../server/documents/service";
import { DocumentBroker } from "../server/documents/broker";
import { DocumentError } from "../src/lib/documents/errors";
import { revisionOf } from "../src/lib/documents/revision";
import { readFileAtCommit } from "../src/lib/git/git-service";
import { GET as assetsGET } from "../src/app/api/assets/[...path]/route";
import type { DocumentChangeEvent } from "../server/documents/service";

const services: DocumentService[] = [];
test.after(async () => {
  for (const s of services) await s.shutdown();
});

async function writeDoc(rel: string, bytes: Uint8Array): Promise<string> {
  const abs = path.join(DATA_DIR, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, bytes);
  return abs;
}

test("revision endpoint: cache hit avoids re-hash; stat change re-hashes", async () => {
  const svc = new DocumentService(new DocumentBroker({ concurrency: 1 }));
  services.push(svc);
  const v0 = await variantDocx("a0");
  const abs = await writeDoc("rev/a.docx", v0);
  const real = await fsm.promises.realpath(abs);

  const r1 = await svc.revision("rev/a.docx");
  assert.equal(r1.revision, revisionOf(v0));
  assert.equal(r1.size, v0.byteLength);

  // Count reads of this file through the shared fs.promises object.
  const patched = fsm.promises as unknown as { readFile: typeof fsm.promises.readFile };
  const restore = patched.readFile;
  let reads = 0;
  patched.readFile = (async (...args: Parameters<typeof fsm.promises.readFile>) => {
    if (String(args[0]) === real) reads++;
    return restore.apply(fsm.promises, args);
  }) as typeof fsm.promises.readFile;
  try {
    const r2 = await svc.revision("rev/a.docx");
    assert.equal(r2.revision, r1.revision);
    assert.equal(reads, 0, "cache hit must not re-read the file");

    // Rewrite on disk → stat differs → re-hash.
    const v1 = await variantDocx("a1");
    await fs.writeFile(abs, v1);
    const r3 = await svc.revision("rev/a.docx");
    assert.equal(r3.revision, revisionOf(v1));
    assert.equal(reads, 1);
  } finally {
    patched.readFile = restore;
  }
});

test("onDocumentChanged fires once per successful commit, not on failures", async () => {
  const events: DocumentChangeEvent[] = [];
  const svc = new DocumentService(new DocumentBroker({ concurrency: 1 }), {
    onDocumentChanged: (e) => events.push(e),
  });
  services.push(svc);
  const v0 = await variantDocx("b0");
  const abs = await writeDoc("rev/b.docx", v0);
  void abs;

  const { tempPath } = await svc.prepareSaveTarget("rev/b.docx");
  const v1 = await variantDocx("b1");
  await fs.writeFile(tempPath, v1);
  await svc.save({ virtualPath: "rev/b.docx", baseRevision: revisionOf(v0), tempPath });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.op, "save");
  assert.equal(events[0]!.virtualPath, "rev/b.docx");
  assert.equal(events[0]!.revision, revisionOf(v1));

  const { tempPath: tmp2 } = await svc.prepareSaveTarget("rev/b.docx");
  await fs.writeFile(tmp2, v0);
  await assert.rejects(
    svc.save({ virtualPath: "rev/b.docx", baseRevision: "sha256:stale", tempPath: tmp2 }),
    (e) => e instanceof DocumentError && e.code === "conflict",
  );
  assert.equal(events.length, 1, "failed commit must not emit a change event");
});

test("readFileAtCommit round-trips binary bytes exactly", async () => {
  const git = simpleGit(DATA_DIR);
  const gitDir = path.join(DATA_DIR, ".git");
  if (!(await fsm.promises.stat(gitDir).then(() => true).catch(() => false))) {
    await git.init();
    await git.addConfig("user.email", "kb@cabinet.dev");
    await git.addConfig("user.name", "Cabinet");
  }
  const payload = Buffer.concat([
    Buffer.from("%PDF-1.7\r\n"),
    Buffer.from([0x00, 0x01, 0x0d, 0x0a, 0xff, 0x00]),
    Buffer.from("\r\nbinary tail\r\n"),
  ]);
  const rel = "rev/binary.pdf";
  const abs = await writeDoc(rel, payload);
  void abs;
  await git.add(rel);
  const commit = await git.commit("add binary fixture");
  assert.ok(commit.commit);
  const back = await readFileAtCommit(commit.commit, rel);
  assert.ok(back);
  assert.deepEqual(back, payload);
  assert.equal(await readFileAtCommit(commit.commit, "rev/nope.pdf"), null);
});

test("assets GET for .pdf: no-cache + weak ETag + 304 + range still works; .png unchanged", async () => {
  const pdfBytes = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(256, 7)]);
  const pdfAbs = await writeDoc("assets/probe.pdf", pdfBytes);
  const stat = await fs.stat(pdfAbs);
  const expectedEtag = `W/"${stat.size}-${Math.round(stat.mtimeMs)}"`;

  const ctx = { params: Promise.resolve({ path: ["assets/probe.pdf"] }) };
  const res = await assetsGET(
    new NextRequest("http://localhost/api/assets/assets/probe.pdf"),
    ctx,
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "private, no-cache");
  assert.equal(res.headers.get("etag"), expectedEtag);

  const res304 = await assetsGET(
    new NextRequest("http://localhost/api/assets/assets/probe.pdf", {
      headers: { "if-none-match": expectedEtag },
    }),
    { params: Promise.resolve({ path: ["assets/probe.pdf"] }) },
  );
  assert.equal(res304.status, 304);

  const res206 = await assetsGET(
    new NextRequest("http://localhost/api/assets/assets/probe.pdf", {
      headers: { range: "bytes=0-9" },
    }),
    { params: Promise.resolve({ path: ["assets/probe.pdf"] }) },
  );
  assert.equal(res206.status, 206);
  assert.equal((await res206.arrayBuffer()).byteLength, 10);

  // Non-document binary keeps the existing public cache.
  await writeDoc("assets/pic.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
  const pngRes = await assetsGET(
    new NextRequest("http://localhost/api/assets/assets/pic.png"),
    { params: Promise.resolve({ path: ["assets/pic.png"] }) },
  );
  assert.equal(pngRes.status, 200);
  assert.equal(pngRes.headers.get("cache-control"), "public, max-age=3600");
  assert.equal(pngRes.headers.get("etag"), null);
});
