#!/usr/bin/env node
/**
 * End-to-end boot smoke test for `cabinetai run`.
 *
 * Unlike test-zero-install.mjs (which stubs server.js and only exercises the
 * download → extract → validate plumbing), this test boots the REAL built
 * bundle the way `npx cabinetai run` does, and asserts the app and daemon
 * actually come up and serve health.
 *
 * Prerequisite: a runnable bundle must already exist at .next/standalone.
 *   npm run build && npm run electron:prep
 *
 * What this tests:
 *   - `cabinetai run` resolves/bootstraps a cabinet dir
 *   - ensureApp() short-circuits on an already-installed runtime (no download)
 *   - the standalone Next server boots and serves GET /api/health → 200
 *   - the daemon boots and serves GET /health → 200
 *   - the native-module / bundled-node ABI contract holds (better-sqlite3,
 *     node-pty) — the exact thing the stub test cannot catch
 *
 * Isolation: installs the bundle as version v0.0.0-bundle-test under the real
 * CABINET_HOME (~/.cabinet) via a symlink to .next/standalone (never copies,
 * never touches the build output), uses a throwaway temp cabinet data dir, and
 * picks free ports. Everything is cleaned up on exit.
 *
 * Usage:
 *   node scripts/test-bundle.mjs
 */

import fs from "fs";
import os from "os";
import net from "net";
import path from "path";
import { execFileSync, spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { runChecks } from "./smoke-checks.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CABINETAI_DIR = path.join(ROOT, "cabinetai");
const STANDALONE = path.join(ROOT, ".next", "standalone");

const TEST_VERSION = "0.0.0-bundletest";
const APP_DIR = path.join(os.homedir(), ".cabinet", "app", `v${TEST_VERSION}`);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cabinet-bundle-test-"));

let child = null;
let isoDaemon = null;
let isoDir = null;
let cleanedUp = false;
let childOutput = "";

// ─── helpers ─────────────────────────────────────────────────────────────────

function step(msg) { console.log(`\n\x1b[36m▶ ${msg}\x1b[0m`); }
function ok(msg)   { console.log(`\x1b[32m✓ ${msg}\x1b[0m`); }
function info(msg) { console.log(`\x1b[90m  ${msg}\x1b[0m`); }

function removeAppDir() {
  // APP_DIR is our symlink to the build output — unlink the LINK, never recurse
  // into the target (that would delete .next/standalone).
  try {
    const st = fs.lstatSync(APP_DIR);
    if (st.isSymbolicLink()) fs.unlinkSync(APP_DIR);
    else fs.rmSync(APP_DIR, { recursive: true, force: true });
  } catch {
    // not present — fine
  }
}

function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  if (child && child.pid) {
    // child is a detached group leader; signal the whole group so the app and
    // daemon it spawned die too.
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }
  if (isoDaemon && isoDaemon.pid) {
    try { process.kill(-isoDaemon.pid, "SIGTERM"); } catch {}
    try { process.kill(-isoDaemon.pid, "SIGKILL"); } catch {}
  }
  removeAppDir();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  if (isoDir) fs.rmSync(isoDir, { recursive: true, force: true });
}

function fail(msg) {
  console.error(`\n\x1b[31m✗ FAIL: ${msg}\x1b[0m`);
  if (childOutput) {
    if (/NODE_MODULE_VERSION/.test(childOutput)) {
      console.error(
        "\x1b[33m  Hint: native-module ABI mismatch. The bundled bin/node and the\n" +
        "  traced better-sqlite3/node-pty were built against different Node\n" +
        "  versions. Rebuild with a single Node: `npm rebuild better-sqlite3`\n" +
        "  then re-run `npm run build && npm run electron:prep`.\x1b[0m"
      );
    }
    console.error("\x1b[90m─── last of `cabinetai run` output ───\x1b[0m");
    console.error(childOutput.slice(-4000));
  }
  cleanup();
  process.exit(1);
}

process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

/** One-page PDF with real text — no external fixture needed. */
async function makePdfBytes(text) {
  // Minimal hand-rolled PDF: one page, Helvetica text.
  const escaped = text.replace(/[()\\]/g, "\\$&");
  const stream = `BT /F1 16 Tf 60 740 Td (${escaped}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objs.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

async function pollHealth(url, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (cleanedUp) return null; // child died — stop polling
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return r.status;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

// ─── 1. Require a runnable bundle ─────────────────────────────────────────────

step("Checking for a built bundle at .next/standalone...");

const REQUIRED = [
  "server.js",
  path.join("server", "cabinet-daemon.cjs"),
  path.join(".next", "static"),
  path.join(".native", "node-pty", "package.json"),
];
const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(STANDALONE, f)));
if (!fs.existsSync(STANDALONE) || missing.length > 0) {
  fail(
    `No runnable bundle (missing: ${missing.join(", ") || ".next/standalone"}).\n` +
    "  Build one first:  npm run build && npm run electron:prep"
  );
}
ok("Found server.js, daemon, .next/static, and bundled node-pty");

// ─── 2. Stage as an installed version so ensureApp() skips the download ───────

step(`Staging bundle as installed v${TEST_VERSION} (symlink → .next/standalone)...`);
removeAppDir();
fs.mkdirSync(path.dirname(APP_DIR), { recursive: true });
fs.symlinkSync(STANDALONE, APP_DIR, "dir");
ok(`Linked ${APP_DIR}`);

// ─── 3. Boot via `cabinetai run` (the real npx entrypoint) ────────────────────

const appPort = await freePort();
const daemonPort = await freePort();

step(`Booting \`cabinetai run\` (app:${appPort}, daemon:${daemonPort})...`);

const tsx = path.join(ROOT, "node_modules", ".bin", "tsx");
if (!fs.existsSync(tsx)) fail(`tsx not found at ${tsx} — run npm ci first`);

child = spawn(
  tsx,
  [
    path.join(CABINETAI_DIR, "src", "index.ts"),
    "run",
    "--app-version", TEST_VERSION,
    "--no-open",
    "--data-dir", DATA_DIR,
  ],
  {
    cwd: ROOT,
    detached: true, // own process group → we can kill app+daemon together
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      CABINET_APP_PORT: String(appPort),
      CABINET_DAEMON_PORT: String(daemonPort),
    },
  }
);
child.stdout.on("data", (d) => { childOutput += d; });
child.stderr.on("data", (d) => { childOutput += d; });
child.on("exit", (code) => {
  // `cabinetai run` only exits when one of its children dies. If that happens
  // before we observed health, the boot failed.
  if (!cleanedUp) fail(`\`cabinetai run\` exited early (code ${code}) before becoming healthy`);
});

// ─── 4. Assert health ─────────────────────────────────────────────────────────

step("Waiting for the app server to become healthy...");
const appStatus = await pollHealth(`http://127.0.0.1:${appPort}/api/health`, 90_000);
if (appStatus !== 200) fail(`app GET /api/health never returned 200 (got ${appStatus ?? "no response"})`);
ok("app GET /api/health → 200");

step("Waiting for the daemon to become healthy...");
const daemonStatus = await pollHealth(`http://127.0.0.1:${daemonPort}/health`, 30_000);
if (daemonStatus !== 200) fail(`daemon GET /health never returned 200 (got ${daemonStatus ?? "no response"})`);
ok("daemon GET /health → 200");

// ─── 5. Sanity: the app serves real HTML ──────────────────────────────────────

step("Verifying the app serves HTML...");
try {
  const html = await (await fetch(`http://127.0.0.1:${appPort}/`, { signal: AbortSignal.timeout(5000) })).text();
  if (/<title>/i.test(html)) ok("app serves an HTML document");
  else info("app responded but no <title> seen (continuing)");
} catch {
  info("could not fetch / for HTML check (continuing — health already passed)");
}

// ─── 6. Journey checks against the live pair ──────────────────────────────────

try {
  await runChecks({
    appUrl: `http://127.0.0.1:${appPort}`,
    daemonUrl: `http://127.0.0.1:${daemonPort}`,
  });
} catch (err) {
  fail(`journey check failed: ${err.message}`);
}

// ─── 7. Documents phase: prove the bundle is self-contained ──────────────────
//
// The symlinked install above can still resolve the REPO's node_modules
// (Node walks up to the project root). To prove the document engines work
// with zero repo dependencies we copy the standalone tree into a temp dir
// that has no node_modules ancestor, boot the bundled daemon from it, and
// drive every engine through server/document-tool.mjs: docx inspect, pdf
// inspect + patch (pdfium + harfbuzz wasm), pdf→docx convert, pdfcn render
// (takumi wasm + staged fonts), and OCR capability probing.

step("Staging an isolated copy of the bundle (no repo node_modules ancestor)...");

isoDir = fs.mkdtempSync(path.join(os.tmpdir(), "cabinet-doc-iso-"));
const ISO_DIR = isoDir;
const ISO_APP = path.join(ISO_DIR, "app");
const ISO_DATA = path.join(ISO_DIR, "data");
fs.cpSync(STANDALONE, ISO_APP, { recursive: true });
fs.mkdirSync(path.join(ISO_DATA, "Cabinet"), { recursive: true });

const DOC_REQUIRED = [
  path.join("server", "cabinet-daemon.cjs"),
  path.join("server", "document-worker.mjs"),
  path.join("server", "document-tool.mjs"),
  path.join("server", "browser-tool.mjs"),
  path.join("documents", "pdf-fonts", "LiberationSans-Regular.ttf"),
  path.join("node_modules", "takumi-pdf", "pkg", "takumi_pdf_wasm_bg.wasm"),
  path.join("node_modules", "@embedpdf", "pdfium", "dist", "pdfium.wasm"),
  path.join("node_modules", "harfbuzzjs", "hb-subset.wasm"),
  "THIRD_PARTY_NOTICES.md",
];
const docMissing = DOC_REQUIRED.filter((f) => !fs.existsSync(path.join(ISO_APP, f)));
if (docMissing.length > 0) {
  fail(`isolated bundle is missing document assets: ${docMissing.join(", ")}`);
}
ok("document assets staged: worker bundle, fonts, pdfium/harfbuzz/takumi wasm, notices");

const isoNode = fs.existsSync(path.join(ISO_APP, "bin", "node"))
  ? path.join(ISO_APP, "bin", "node")
  : process.execPath;
const isoDaemonPort = await freePort();

step(`Booting the isolated daemon (daemon:${isoDaemonPort})...`);
isoDaemon = spawn(
  isoNode,
  [path.join(ISO_APP, "server", "cabinet-daemon.cjs")],
  {
    cwd: ISO_APP,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      HOME: os.homedir(),
      NODE_ENV: "production",
      NODE_PATH: path.join(ISO_APP, ".native"),
      CABINET_DATA_DIR: ISO_DATA,
      CABINET_DAEMON_PORT: String(isoDaemonPort),
      CABINET_DAEMON_URL: `http://127.0.0.1:${isoDaemonPort}`,
      CABINET_PUBLIC_DAEMON_ORIGIN: `ws://127.0.0.1:${isoDaemonPort}`,
    },
  }
);
let isoDaemonOut = "";
isoDaemon.stdout.on("data", (d) => { isoDaemonOut += d; });
isoDaemon.stderr.on("data", (d) => { isoDaemonOut += d; });

const isoHealth = await pollHealth(`http://127.0.0.1:${isoDaemonPort}/health`, 30_000);
if (isoHealth !== 200) {
  console.error(isoDaemonOut.slice(-3000));
  fail(`isolated daemon never became healthy (got ${isoHealth ?? "no response"})`);
}
ok("isolated daemon healthy");

function docTool(args, label) {
  const r = spawnSync(
    isoNode,
    [path.join(ISO_APP, "server", "document-tool.mjs"), ...args],
    {
      encoding: "utf8",
      timeout: 120_000,
      env: {
        HOME: os.homedir(),
        CABINET_DATA_DIR: ISO_DATA,
        // runtime-ports.json lives under the app-managed state dir; point the
        // tool at the daemon directly so it cannot fall back to a dev daemon.
        CABINET_DAEMON_URL: `http://127.0.0.1:${isoDaemonPort}`,
      },
    }
  );
  if (r.status !== 0) {
    fail(`cabinet-documents ${label} failed:\n${r.stdout}\n${r.stderr}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    fail(`cabinet-documents ${label} did not return JSON:\n${r.stdout.slice(0, 800)}`);
  }
  return parsed;
}

// Seed fixtures inside the isolated cabinet root.
const ISO_CABINET = path.join(ISO_DATA, "Cabinet");
fs.writeFileSync(
  path.join(ISO_CABINET, "smoke.pdf"),
  await makePdfBytes("Bundle isolated smoke")
);

step("documents: pdf inspect + patch (pdfium + harfbuzz wasm)...");
const pdfInspect = docTool(["inspect", "--path", "smoke.pdf"], "inspect");
if (pdfInspect.format !== "pdf" || pdfInspect.pageCount < 1) {
  fail(`inspect returned unexpected shape: ${JSON.stringify(pdfInspect).slice(0, 300)}`);
}
const line = pdfInspect.pages?.[0]?.textLines?.[0];
if (!line?.id || !line.bounds) fail("inspect produced no editable text lines");
const patched = docTool(
  [
    "patch", "--path", "smoke.pdf",
    "--ops", JSON.stringify([
      { kind: "pdfTextEdit", edit: { pageIndex: 0, rect: line.bounds, oldText: line.text, newText: "Bundle isolated edit", fontSize: 16 } },
    ]),
  ],
  "patch"
);
ok(`inspect (${pdfInspect.pageCount} page) + patch ok${patched?.warnings?.length ? ` (${patched.warnings.length} warnings)` : ""}`);

// cabinet-browser: the tool is staged and reaches the daemon /browser routes
// (no Chromium download needed — status answers regardless).
step("browser: cabinet-browser status...");
{
  // The tool resolves its own data dir, which can differ from the isolated
  // daemon's (active-cabinet lookup reads ~/.cabinet). Pin the token the
  // daemon actually wrote so the request is authenticated either way.
  let isoToken = "";
  try {
    const found = execFileSync(
      "find",
      [ISO_DATA, "-name", "daemon-token", "-maxdepth", "5"],
      { encoding: "utf8" }
    ).trim().split("\n").filter(Boolean)[0];
    if (found) isoToken = fs.readFileSync(found, "utf8").trim();
  } catch { /* token stays empty; the tool falls back to its own lookup */ }
  const r = spawnSync(
    isoNode,
    [path.join(ISO_APP, "server", "browser-tool.mjs"), "status"],
    {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        HOME: os.homedir(),
        CABINET_DATA_DIR: ISO_DATA,
        CABINET_DAEMON_URL: `http://127.0.0.1:${isoDaemonPort}`,
        ...(isoToken ? { CABINET_DAEMON_TOKEN: isoToken } : {}),
      },
    }
  );
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* handled below */ }
  if (r.status !== 0 || typeof parsed?.status !== "string") {
    fail(
      `cabinet-browser status failed (exit=${r.status} signal=${r.signal} ` +
        `error=${r.error ? r.error.message : "none"}):\n${r.stdout}\n${r.stderr}`
    );
  }
  ok(`cabinet-browser status ok (status=${parsed.status})`);
}

step("documents: convert pdf → docx (worker pipeline)...");
const conv = docTool(["convert", "--path", "smoke.pdf", "--wait"], "convert --wait");
if (conv?.pageCount < 1 || !fs.existsSync(path.join(ISO_CABINET, "smoke.docx"))) {
  fail(`convert produced no docx: ${JSON.stringify(conv).slice(0, 300)}`);
}
ok("convert --wait produced a docx");

step("documents: pdfcn render (takumi wasm + staged fonts)...");
docTool(["pdf-new", "--path", "comp.pdf.source.json", "--template", "report"], "pdf-new");
const rendered = docTool(
  ["pdf-render", "--path", "comp.pdf.source.json", "--publish", "--wait"],
  "pdf-render"
);
if (!fs.existsSync(path.join(ISO_CABINET, "comp.pdf"))) {
  fail(`pdf-render --publish did not produce comp.pdf: ${JSON.stringify(rendered).slice(0, 300)}`);
}
const status = docTool(["pdf-status", "--path", "comp.pdf.source.json"], "pdf-status");
if (status?.output?.stale !== false) {
  fail(`pdf-status not clean after publish: ${JSON.stringify(status).slice(0, 300)}`);
}
ok("pdf-new → pdf-render --publish --wait → pdf-status (stale:false)");

step("documents: ocr capabilities...");
const ocr = docTool(["ocr-capabilities"], "ocr-capabilities");
info(`ocr provider: ${JSON.stringify(ocr).slice(0, 200)}`);
ok("ocr-capabilities responded");

try { process.kill(-isoDaemon.pid, "SIGTERM"); } catch {}
isoDaemon = null;
fs.rmSync(ISO_DIR, { recursive: true, force: true });
isoDir = null;

console.log(`\n\x1b[32m✓ Bundle boot smoke test passed — \`cabinetai run\` boots the real bundle.\x1b[0m`);
cleanup();
process.exit(0);
