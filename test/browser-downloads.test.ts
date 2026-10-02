import test from "node:test";
import assert from "node:assert/strict";
import { BrowserDownloadService, cleanFilename, publicIp, scopedDirectory } from "../server/browser/download-service";
import { Readable } from "node:stream";
import fsp from "node:fs/promises";
import type http from "node:http";

const context = { runId: "run", agentSlug: "researcher", cabinetPath: "room" };

function incoming(statusCode: number, headers: Record<string, string>, body = ""): http.IncomingMessage {
  const stream = Readable.from([Buffer.from(body)]) as http.IncomingMessage;
  stream.statusCode = statusCode;
  stream.headers = headers;
  return stream;
}

test("download policy rejects private and reserved address ranges", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.1.1",
    "100.64.0.1",
    "192.0.2.1",
    "198.51.100.2",
    "203.0.113.3",
    "::1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b:1::1",
    "2002:7f00:1::",
  ]) assert.equal(publicIp(address), false, address);
  assert.equal(publicIp("8.8.8.8"), true);
  assert.equal(publicIp("2606:4700:4700::1111"), true);
});

test("download destinations remain in the active visible room", () => {
  assert.equal(scopedDirectory(context, "Research/Papers"), "room/Research/Papers");
  for (const invalid of ["", "/absolute", "../sibling", ".agents/files", "safe/../escape"]) {
    assert.throws(() => scopedDirectory(context, invalid), /visible folder/);
  }
  assert.equal(cleanFilename("../../A paper?.pdf"), "-..-A paper-.pdf");
});

test("download follows bounded redirects and imports bytes with provenance", async () => {
  const requested: string[] = [];
  const imported: { destinationVirtualPath: string; bytes: Buffer }[] = [];
  const documentService = {
    importStaged: async (input: { destinationVirtualPath: string; tempPath: string }) => {
      imported.push({ destinationVirtualPath: input.destinationVirtualPath, bytes: await fsp.readFile(input.tempPath) });
      return { virtualPath: input.destinationVirtualPath, revision: "r1", size: imported.at(-1)!.bytes.length };
    },
    importText: async (input: { destinationVirtualPath: string; bytes: Uint8Array }) => {
      imported.push({ destinationVirtualPath: input.destinationVirtualPath, bytes: Buffer.from(input.bytes) });
      return { virtualPath: input.destinationVirtualPath, revision: "r2", size: input.bytes.byteLength };
    },
  };
  const service = new BrowserDownloadService({
    documentService: documentService as never,
    request: async (url) => {
      requested.push(url.toString());
      return requested.length === 1
        ? incoming(302, { location: "https://cdn.example.test/paper.pdf" })
        : incoming(200, { "content-type": "application/pdf", "content-disposition": "attachment; filename=paper.pdf" }, "%PDF-1.4\n%%EOF\n");
    },
  });
  const output = await service.call(context, "browser_download", {
    url: "https://example.test/download",
    destinationDir: "Research",
  }, async () => ({ content: [] }));
  const result = output.structuredContent!;
  assert.equal(result.virtualPath, "room/Research/paper.pdf");
  assert.deepEqual(requested, ["https://example.test/download", "https://cdn.example.test/paper.pdf"]);
  assert.match(imported[0].bytes.toString(), /^%PDF-/);
  assert.equal(imported.length, 2);
  assert.equal(JSON.parse(imported[1].bytes.toString()).finalUrl, "https://cdn.example.test/paper.pdf");
});

test("download refuses HTML masquerading as a supported file", async () => {
  const service = new BrowserDownloadService({
    documentService: {} as never,
    request: async () => incoming(200, { "content-type": "text/html" }, "<html>login</html>"),
  });
  await assert.rejects(
    service.call(context, "browser_import_pdf", { url: "https://example.test/paper.pdf", destinationDir: "Research" }, async () => ({ content: [] })),
    /HTML page/,
  );
});

test("save page publishes passive Markdown without element refs or executable HTML", async () => {
  let saved = "";
  const service = new BrowserDownloadService({
    documentService: {
      importText: async (input: { destinationVirtualPath: string; bytes: Uint8Array }) => {
        saved = Buffer.from(input.bytes).toString();
        return { virtualPath: input.destinationVirtualPath, revision: "r", size: input.bytes.byteLength };
      },
    } as never,
  });
  const result = await service.call(context, "browser_save_page", {
    tabId: "T1",
    destinationDir: "Research",
    title: "Captured",
  }, async () => ({
    content: [{ type: "text", text: 'Tab: "Fixture"\nURL: https://example.test/page?token=secret\n<untrusted_page_markdown K="X"><interactive_page_markdown># Page\n[Go](https://example.test) {aloha-id="abcdef12" a}\n<script>alert(1)</script>\n<img src=x onerror=alert(1)></interactive_page_markdown></untrusted_page_markdown>' }],
  }));
  assert.equal(result.structuredContent?.virtualPath, "room/Research/Captured.md");
  assert.doesNotMatch(saved, /aloha-id|<script|token=secret|(^|\n)<img/);
  assert.match(saved, /`<img src=x onerror=alert\(1\)>`/);
});

test("download enforces streamed size limits", async () => {
  const service = new BrowserDownloadService({
    documentService: {} as never,
    maxBytes: 5,
    request: async () => incoming(200, { "content-type": "application/pdf" }, "%PDF-123456"),
  });
  await assert.rejects(
    service.call(context, "browser_import_pdf", { url: "https://example.test/paper.pdf", destinationDir: "Research" }, async () => ({ content: [] })),
    /size limit/,
  );
});

test("download refuses a host if any resolved address is private", async () => {
  const service = new BrowserDownloadService({
    documentService: {} as never,
    lookup: (async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]) as never,
  });
  await assert.rejects(
    service.call(context, "browser_download", { url: "https://example.com/file.pdf", destinationDir: "Research" }, async () => ({ content: [] })),
    /private or reserved/,
  );
});
