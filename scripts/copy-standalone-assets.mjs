// Runs automatically after `next build` (postbuild hook).
//
// Next.js copies server code to .next/standalone/ but intentionally omits
// static assets — they are meant to be served by a CDN in typical cloud
// deployments. When Cabinet is self-hosted and the standalone server handles
// all traffic directly, the assets must live alongside server.js so that
// /_next/static/* and /public/* routes resolve correctly. Without this copy
// the server starts and the API responds, but every page loads blank because
// the JS/CSS bundles (and public files) return 404.
//
// Reference: https://nextjs.org/docs/app/api-reference/config/next-config-js/output#automatically-copying-traced-files

import fs from "fs";
import path from "path";

const ROOT = process.cwd();

// next.config.ts sets outputFileTracingRoot to the parent of the project dir
// so the standalone bundle is nested one level deeper than usual.
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const projectName = path.basename(ROOT); // "cabinet" in most setups
const STANDALONE = path.join(ROOT, ".next", "standalone", projectName);

if (!fs.existsSync(STANDALONE)) {
  // outputFileTracingRoot may have changed the nesting — fall back to the
  // flat layout (server.js directly in .next/standalone/).
  const flat = path.join(ROOT, ".next", "standalone");
  if (fs.existsSync(path.join(flat, "server.js"))) {
    copyAssets(flat);
  } else {
    console.warn(
      `[cabinet] postbuild: standalone dir not found at ${STANDALONE} or ${flat}. ` +
        "Static assets were NOT copied — production server may serve blank pages."
    );
  }
} else {
  copyAssets(STANDALONE);
}

function copyAssets(standaloneDir) {
  copyDir(
    path.join(ROOT, ".next", "static"),
    path.join(standaloneDir, ".next", "static")
  );
  copyDir(path.join(ROOT, "public"), path.join(standaloneDir, "public"));
  console.log(`[cabinet] Standalone assets copied to ${standaloneDir}`);
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
