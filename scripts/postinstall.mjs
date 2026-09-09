#!/usr/bin/env node
import { execSync } from "child_process";
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import process from "process";

const require = createRequire(import.meta.url);

// macOS arm64 node-pty needs two fixes: the prebuilt spawn-helper must be
// executable, and Gatekeeper's quarantine xattr has to be stripped from the
// native binaries or the PTY won't open. We only warn on platforms where
// these fixes are *expected* to apply — otherwise the user sees scary
// messages on Linux/Windows where the prebuild simply isn't there.
const isMacArm64 = process.platform === "darwin" && process.arch === "arm64";

const ptyPrebuildDir = path.join(
  "node_modules",
  "node-pty",
  "prebuilds",
  "darwin-arm64",
);
const spawnHelper = path.join(ptyPrebuildDir, "spawn-helper");
const ptyNode = path.join(ptyPrebuildDir, "pty.node");

const macFixes = [
  { label: "chmod spawn-helper", cmd: `chmod +x ${spawnHelper}`, target: spawnHelper },
  { label: "strip quarantine xattr (spawn-helper)", cmd: `xattr -d com.apple.provenance ${spawnHelper}`, target: spawnHelper },
  { label: "strip quarantine xattr (pty.node)", cmd: `xattr -d com.apple.provenance ${ptyNode}`, target: ptyNode },
];

for (const { label, cmd, target } of macFixes) {
  // Skip silently when the file isn't there — that's the normal case on
  // Linux/Windows or before node-pty has been installed yet.
  if (!fs.existsSync(target)) continue;
  try {
    execSync(cmd, { stdio: "ignore" });
  } catch (err) {
    if (isMacArm64) {
      const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
      // `xattr -d` exits non-zero if the attribute is already absent — that's
      // success from our perspective, so don't warn for that specific case.
      const benign = label.startsWith("strip quarantine") && /No such xattr/.test(detail);
      if (!benign) {
        console.warn(
          `[cabinet] postinstall: ${label} failed — ${detail}. ` +
            "Terminal/PTY features may be unavailable; reinstall node-pty if it doesn't open.",
        );
      }
    }
    // Non-mac platforms: ignore silently.
  }
}

// Copy latex.js static assets (CSS, JS, fonts, document classes) to
// public/latex-js/ so the LaTeX embed iframe can load them at /latex-js/.
const latexJsDist = path.join("node_modules", "latex.js", "dist");
const latexJsPublic = path.join("public", "latex-js");
if (fs.existsSync(latexJsDist)) {
  try {
    fs.rmSync(latexJsPublic, { recursive: true, force: true });
    fs.mkdirSync(latexJsPublic, { recursive: true });
    for (const dir of ["css", "js", "fonts", "documentclasses", "packages"]) {
      const src = path.join(latexJsDist, dir);
      if (fs.existsSync(src)) {
        copyDirRecursive(src, path.join(latexJsPublic, dir));
      }
    }
    // Copy the main library files (parser + custom element)
    for (const file of ["latex.mjs", "latex.js"]) {
      const src = path.join(latexJsDist, file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(latexJsPublic, file));
      }
    }
    console.log("[cabinet] postinstall: latex.js assets copied to public/latex-js/");
  } catch (err) {
    // A failed copy leaves the LaTeX embed iframe unable to load /latex-js/
    // assets at runtime, so surface it as an error and fail the install rather
    // than letting a broken build slip through.
    console.error("[cabinet] postinstall: failed to copy latex.js assets:", err);
    process.exitCode = 1;
  }
}

// Copy monaco-editor static assets to public/monaco/vs/ so Monaco can be loaded offline
const monacoDist = path.join("node_modules", "monaco-editor", "min", "vs");
const monacoPublic = path.join("public", "monaco", "vs");
if (fs.existsSync(monacoDist)) {
  try {
    fs.rmSync(monacoPublic, { recursive: true, force: true });
    copyDirRecursive(monacoDist, monacoPublic);
    console.log("[cabinet] postinstall: monaco-editor assets copied to public/monaco/vs/");
  } catch (err) {
    console.error("[cabinet] postinstall: failed to copy monaco-editor assets:", err);
    process.exitCode = 1;
  }
}


function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// better-sqlite3 prebuilds/compiled bindings are tied to a specific
// NODE_MODULE_VERSION; if the active runtime doesn't match, rebuild from
// source so the daemon boots cleanly regardless of which Node version is
// active.
//
// A bare `require("better-sqlite3")` only loads the JS wrapper — the native
// `.node` binding is dlopen'd lazily by `bindings()` inside the `Database`
// constructor (lib/database.js), not at module-load time. So the check below
// must actually open a database, or a stale/mismatched native binary slips
// past here undetected and only fails later when the real daemon boots.
try {
  const Database = require("better-sqlite3");
  new Database(":memory:").close();
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  const mismatch =
    msg.includes("NODE_MODULE_VERSION") ||
    msg.includes("ERR_DLOPEN_FAILED") ||
    msg.includes("was compiled against a different Node.js version");
  if (mismatch) {
    const runtime = `Node ${process.version} (NODE_MODULE_VERSION ${process.versions.modules})`;
    console.warn(
      `[cabinet] better-sqlite3 prebuild does not match this runtime — ${runtime}. Rebuilding from source…`,
    );
    // `--build-from-source` was removed as a recognized flag in npm 12
    // (EUNKNOWNCONFIG). A plain rebuild already runs better-sqlite3's own
    // install script (`node-gyp rebuild`), which always compiles from
    // source, so no flag is needed.
    let rebuildOutput = "";
    try {
      rebuildOutput = execSync("npm rebuild better-sqlite3 2>&1", {
        encoding: "utf8",
      });
    } catch (rebuildErr) {
      rebuildOutput =
        (rebuildErr.stdout && rebuildErr.stdout.toString()) ||
        (rebuildErr instanceof Error ? rebuildErr.message : String(rebuildErr));
    }
    console.log(rebuildOutput.trim());

    // Re-verify in a fresh child process rather than retrying in-process:
    // that mirrors exactly how the real daemon will load the addon, and
    // doesn't depend on how Node's require cache treats a module that threw
    // during a native dlopen.
    try {
      execSync(
        `node -e "new (require('better-sqlite3'))(':memory:').close();"`,
        { stdio: "pipe" },
      );
      console.warn("[cabinet] better-sqlite3 rebuilt successfully.");
    } catch {
      // npm 12+ silently skips a dependency's install script unless it's
      // listed in package.json's `allowScripts` — so `npm rebuild` can exit
      // 0 without actually recompiling anything. Detect that case and point
      // at the fix instead of just saying "rebuild failed".
      const scriptsBlocked = rebuildOutput.includes("allowScripts");
      console.warn(
        scriptsBlocked
          ? "[cabinet] better-sqlite3's install script is blocked by npm's allowScripts policy. " +
              "Run `npm install-scripts approve better-sqlite3` and then `npm rebuild better-sqlite3` before starting the daemon."
          : "[cabinet] Auto-rebuild failed. Run `npm rebuild better-sqlite3` manually before starting the daemon.",
      );
    }
  } else {
    console.warn(`[cabinet] better-sqlite3 smoke test warning: ${msg}`);
  }
}
