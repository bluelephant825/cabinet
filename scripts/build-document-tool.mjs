/**
 * Bundles the document artifacts that ship outside Next.js tracing:
 *   scripts/document-tool.ts       → dist/document-tool.mjs   (agent helper)
 *   server/documents/worker.ts     → dist/document-worker.mjs (doc engine worker)
 *
 * The helper is plain HTTP + path utils — no engines, no sqlite, no vendor
 * code. The worker DOES include the vendored engines, so the packages that
 * load real files from disk at runtime (wasm) stay EXTERNAL: they are staged
 * into a node_modules dir beside the bundle by electron:prep and resolve via
 * normal Node resolution.
 */
import { build as bundle } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const distDir = path.join(projectRoot, "dist");

// Packages whose runtime assets must live on disk next to a resolvable
// node_modules — bundling their JS would orphan the wasm files they read.
const WORKER_EXTERNALS = [
  "takumi-pdf",
  "@takumi-rs/helpers",
  "@embedpdf/pdfium",
  "harfbuzzjs",
];

const atAlias = {
  name: "at-alias",
  setup(b) {
    b.onResolve({ filter: /^@\// }, (args) => {
      const base = path.join(projectRoot, "src", args.path.slice(2));
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return { path: candidate };
        }
      }
      return { path: `${base}.ts` };
    });
  },
};

const common = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  plugins: [atAlias],
  logLevel: "warning",
};

await bundle({
  ...common,
  entryPoints: [path.join(projectRoot, "scripts", "document-tool.ts")],
  outfile: process.env.DOCUMENT_TOOL_OUT || path.join(distDir, "document-tool.mjs"),
});
console.log(`[document-tool] bundled → ${process.env.DOCUMENT_TOOL_OUT || path.join(distDir, "document-tool.mjs")}`);

await bundle({
  ...common,
  entryPoints: [path.join(projectRoot, "server", "documents", "worker.ts")],
  outfile: process.env.DOCUMENT_WORKER_OUT || path.join(distDir, "document-worker.mjs"),
  external: WORKER_EXTERNALS,
  jsx: "automatic",
  banner: {
    // Bundled CJS deps emit require('fs'|'path'|…) calls; ESM has no require.
    js: "import { createRequire as __cabinet_cr } from 'node:module';\nconst require = __cabinet_cr(import.meta.url);",
  },
});
console.log(`[document-worker] bundled → ${process.env.DOCUMENT_WORKER_OUT || path.join(distDir, "document-worker.mjs")}`);
