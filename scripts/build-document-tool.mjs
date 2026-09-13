/**
 * Bundles scripts/document-tool.ts → dist/document-tool.mjs. The helper is
 * plain HTTP + path utils — no engines, no sqlite, no vendor code — so a
 * single esbuild file is the whole artifact the `cabinet-documents` shim
 * execs in packaged installs.
 */
import { build as bundle } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const outfile = process.env.DOCUMENT_TOOL_OUT || path.join(projectRoot, "dist", "document-tool.mjs");

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

await bundle({
  entryPoints: [path.join(projectRoot, "scripts", "document-tool.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile,
  plugins: [atAlias],
  logLevel: "warning",
});

console.log(`[document-tool] bundled → ${outfile}`);
