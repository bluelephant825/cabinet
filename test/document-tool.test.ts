import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

process.env.CABINET_DAEMON_TOKEN ??= "test-doc-token";
const TOKEN = process.env.CABINET_DAEMON_TOKEN;

import { DATA_DIR } from "../src/lib/storage/path-utils";
import { buildBlankDocx } from "../src/vendor/genoffice/packages/docx-engine/src/blank";
import { parseDocx, saveDocx } from "../src/vendor/genoffice/packages/docx-engine/src/index";
import { DocumentService } from "../server/documents/service";
import { DocumentBroker } from "../server/documents/broker";
import { handleDocumentsRequest } from "../server/documents/http";
import { ensureDocumentToolShim, documentToolBinDir } from "../src/lib/documents/tool-shim";
import { getAdapterRuntimePath, agentRunEnv } from "../src/lib/agents/adapters/utils";
import { getRuntimePath } from "../src/lib/agents/provider-cli";
import { PDFDocument, StandardFonts } from "pdf-lib";

const execFileAsync = promisify(execFile);
const TSX = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const TOOL = path.join(process.cwd(), "scripts", "document-tool.ts");

let server: http.Server;
let base: string;
let service: InstanceType<typeof DocumentService>;
let agentMutations: unknown[];

test.before(async () => {
  agentMutations = [];
  service = new DocumentService(new DocumentBroker({ concurrency: 1 }), {
    onAgentMutation: (e) => {
      agentMutations.push(e);
    },
  });
  server = http.createServer((req, res) => {
    void handleDocumentsRequest(req, res, service).then((handled) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  await service.shutdown();
});

async function runTool(
  args: string[],
  options: { cwd?: string; expectFail?: boolean } = {},
): Promise<{ code: number; stdout: string; json: unknown }> {
  const env = {
    ...process.env,
    CABINET_DAEMON_URL: base,
    CABINET_DAEMON_TOKEN: TOKEN!,
    CABINET_AGENT_SLUG: "tool-test-agent",
    CABINET_RUN_ID: "run-1",
  };
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [TSX, "--tsconfig", path.join(process.cwd(), "tsconfig.json"), TOOL, ...args],
      {
        env,
        cwd: options.cwd ?? DATA_DIR,
        maxBuffer: 16 * 1024 * 1024,
        timeout: 120_000,
      },
    );
    return {
      code: 0,
      stdout,
      json: (() => {
        try {
          return JSON.parse(stdout);
        } catch {
          return null;
        }
      })(),
    };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    if (!options.expectFail) throw err;
    return {
      code: e.code ?? 1,
      stdout: e.stdout ?? "",
      json: e.stdout ? JSON.parse(e.stdout) : null,
    };
  }
}

async function docxBytes(): Promise<Uint8Array> {
  const para = (text: string) => ({
    kind: "generated" as const,
    block: { type: "paragraph" as const, runs: [{ text }] },
  });
  const blank = await buildBlankDocx();
  const doc = await parseDocx(blank);
  return saveDocx(doc, [para("Alpha first line"), para("Beta second line")]);
}

async function pdfBytes(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Convert me to Word", { x: 50, y: 700, size: 14, font });
  return doc.save({ useObjectStreams: false });
}

async function writeFixture(rel: string, bytes: Uint8Array): Promise<void> {
  const abs = path.join(DATA_DIR, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, bytes);
}

// ── CLI against the real document service ────────────────────────────────

test("inspect → patch → inspect shows the edit", async () => {
  await writeFixture("tool/a.docx", await docxBytes());

  const inspected = (await runTool(["inspect", "--path", "tool/a.docx"])).json as {
    format: string;
    paragraphs: { id: string; text: string }[];
  };
  assert.equal(inspected.format, "docx");
  const target = inspected.paragraphs.find((p) => p.text.includes("Alpha first line"));
  assert.ok(target);

  const patched = (await runTool([
    "patch",
    "--path",
    "tool/a.docx",
    "--ops",
    JSON.stringify([
      {
        kind: "replaceParagraphText",
        paragraphId: target.id,
        expectedText: target.text,
        newText: "Alpha TOOL edit",
      },
    ]),
  ])).json as { applied: number; revision: string };
  assert.equal(patched.applied, 1);

  const after = (await runTool(["inspect", "--path", "tool/a.docx"])).json as {
    paragraphs: { text: string }[];
  };
  assert.ok(after.paragraphs.some((p) => p.text === "Alpha TOOL edit"));
});

test("read returns document text; search finds it", async () => {
  const read = (await runTool(["read", "--path", "tool/a.docx"])).json as { text: string };
  assert.match(read.text, /Alpha TOOL edit/);
  const found = (await runTool([
    "search",
    "--path",
    "tool/a.docx",
    "--query",
    "Beta second",
  ])).json as { matches: unknown[] };
  assert.ok(found.matches.length >= 1);
});

test("patch with a stale --base-revision exits non-zero with code conflict", async () => {
  const res = await runTool(
    [
      "patch",
      "--path",
      "tool/a.docx",
      "--base-revision",
      "stale-revision",
      "--ops",
      JSON.stringify([
        {
          kind: "replaceParagraphText",
          paragraphId: "p0",
          expectedText: "x",
          newText: "y",
        },
      ]),
    ],
    { expectFail: true },
  );
  assert.notEqual(res.code, 0);
  const err = (res.json as { error: { code: string } }).error;
  assert.equal(err.code, "conflict");
});

test("convert --wait produces a docx with page results", async () => {
  await writeFixture("tool/src.pdf", await pdfBytes());
  const result = (await runTool([
    "convert",
    "--path",
    "tool/src.pdf",
    "--wait",
  ])).json as { virtualPath: string; pageResults?: { status: string }[] };
  assert.ok(result.virtualPath.endsWith(".docx"));
  assert.ok((result.pageResults ?? []).length >= 1);
  const stat = await runTool(["inspect", "--path", result.virtualPath]);
  assert.equal((stat.json as { format: string }).format, "docx");
});

test("--help exits 0 and documents every command", async () => {
  const { stdout } = await runTool(["--help"]);
  for (const cmd of [
    "inspect", "read", "search", "geometry", "patch", "docx-load",
    "docx-save", "convert", "job", "cancel", "ocr-capabilities",
    "recovery", "revision",
    "pdf-new", "pdf-validate", "pdf-catalog", "pdf-render", "pdf-status",
  ]) {
    assert.ok(stdout.includes(cmd), `--help missing ${cmd}`);
  }
});

test("pdf-new → pdf-validate → pdf-render --publish --wait → pdf-status", { timeout: 180_000 }, async () => {
  const vp = "tool/gen/invoice.pdf.source.json";
  const created = (await runTool([
    "pdf-new", "--path", vp, "--template", "invoice", "--title", "Tool Invoice",
  ])).json as { revision: string; size: number };
  assert.ok(created.revision);
  // Composition is valid per the daemon.
  const validated = (await runTool(["pdf-validate", "--path", vp])).json as { ok: boolean };
  assert.equal(validated.ok, true);

  const catalog = (await runTool(["pdf-catalog"])).json as {
    catalogVersion: string;
    components: { type: string }[];
    themes: string[];
  };
  assert.ok(catalog.catalogVersion);
  assert.ok(catalog.components.some((c) => c.type === "table"));
  assert.ok(catalog.themes.includes("professional"));

  const rendered = (await runTool([
    "pdf-render", "--path", vp, "--publish", "--wait",
  ])).json as { virtualPath: string; pageCount: number };
  assert.equal(rendered.virtualPath, "tool/gen/invoice.pdf");
  assert.ok(rendered.pageCount >= 1);
  const bytes = await fs.readFile(path.join(DATA_DIR, rendered.virtualPath));
  assert.equal(bytes.subarray(0, 5).toString("latin1"), "%PDF-");

  const status = (await runTool(["pdf-status", "--path", vp])).json as {
    sourceRevision: string;
    output?: { virtualPath: string; stale: boolean; modified: boolean };
  };
  assert.equal(status.output?.virtualPath, "tool/gen/invoice.pdf");
  assert.equal(status.output?.stale, false);
  assert.equal(status.output?.modified, false);
});

test("error output never leaks the absolute data dir or the daemon token", async () => {
  const res = await runTool(
    ["inspect", "--path", "tool/does-not-exist.pdf"],
    { expectFail: true },
  );
  assert.notEqual(res.code, 0);
  assert.ok(!res.stdout.includes(path.resolve(DATA_DIR)), res.stdout);
  assert.ok(!res.stdout.includes(TOKEN!), res.stdout);
});

// ── agent-actor attribution seam ─────────────────────────────────────────

test("agent-actor commit fires onAgentMutation once; user-actor does not", async () => {
  agentMutations = [];
  await writeFixture("tool/b.docx", await docxBytes());

  // Agent path: same call the CLI makes — open + patch with an agent actor.
  const opened = await service.open({
    virtualPath: "tool/b.docx",
    actor: { kind: "agent", id: "tool-test-agent", runId: "run-1" },
  });
  const inspected = await service.inspect({ sessionId: opened.sessionId });
  const target = (inspected as { paragraphs: { id: string; text: string }[] }).paragraphs[0]!;
  await service.applyPatch({
    sessionId: opened.sessionId,
    baseRevision: opened.revision,
    ops: [
      {
        kind: "replaceParagraphText",
        paragraphId: target.id,
        expectedText: target.text,
        newText: "agent edit",
      },
    ],
    actor: { kind: "agent", id: "tool-test-agent", runId: "run-1" },
  });
  assert.equal(agentMutations.length, 1);
  const ev = agentMutations[0] as { actor: { kind: string; id: string; runId?: string }; virtualPath: string };
  assert.equal(ev.actor.kind, "agent");
  assert.equal(ev.actor.id, "tool-test-agent");
  assert.equal(ev.actor.runId, "run-1");
  assert.equal(ev.virtualPath, "tool/b.docx");

  // User path: browser route shape (no actor) must NOT trigger it.
  const userOpened = await service.open({ virtualPath: "tool/b.docx" });
  const userInspected = await service.inspect({ sessionId: userOpened.sessionId });
  const userTarget = (userInspected as { paragraphs: { id: string; text: string }[] }).paragraphs[0]!;
  await service.applyPatch({
    sessionId: userOpened.sessionId,
    baseRevision: userOpened.revision,
    ops: [
      {
        kind: "replaceParagraphText",
        paragraphId: userTarget.id,
        expectedText: userTarget.text,
        newText: "user edit",
      },
    ],
  });
  assert.equal(agentMutations.length, 1, "user-actor patch must not fire onAgentMutation");
});

// ── shim + PATH ──────────────────────────────────────────────────────────

test("shim is written idempotently with 0755 and both PATH builders prepend the bin dir", async () => {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-doc-bin-"));
  const argv = ["/usr/bin/node", "/tmp/tool.mjs"];
  ensureDocumentToolShim({ binDir, argv });
  const shim = path.join(binDir, "cabinet-documents");
  const stat = await fs.stat(shim);
  assert.equal(stat.mode & 0o777, 0o755);
  const first = await fs.readFile(shim, "utf8");
  assert.match(first, /^#!\/bin\/sh\nexec /);
  // Idempotent — same content, no error.
  ensureDocumentToolShim({ binDir, argv });
  assert.equal(await fs.readFile(shim, "utf8"), first);

  const realBin = documentToolBinDir();
  assert.equal(getAdapterRuntimePath().split(path.delimiter)[0], realBin);
  assert.equal(getRuntimePath().split(path.delimiter)[0], realBin);
});

test("agentRunEnv stamps slug/run/cabinet without secrets", () => {
  const env = agentRunEnv({ runId: "r1", agentSlug: "editor", cabinetPath: "room" });
  assert.equal(env.CABINET_AGENT_SLUG, "editor");
  assert.equal(env.CABINET_RUN_ID, "r1");
  assert.equal(env.CABINET_CABINET_PATH, "room");
  assert.ok(!("CABINET_DAEMON_TOKEN" in env));
});
