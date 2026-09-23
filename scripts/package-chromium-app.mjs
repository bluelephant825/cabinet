#!/usr/bin/env node
/**
 * Assemble the packaged Cabinet.app from a Chromium fork build.
 *
 * Layout (macOS):
 *   Cabinet.app/Contents/
 *     Info.plist                     CFBundleExecutable=Cabinet, com.runcabinet.cabinet
 *     MacOS/Cabinet                  Node SEA running launcher/cabinet-launcher.cjs
 *     MacOS/Chromium                 the fork's browser binary (spawned by the
 *                                    daemon via CABINET_CHROMIUM_PATH)
 *     Frameworks/Chromium Framework.framework/   (copied verbatim from the fork)
 *     Resources/app/                 the staged .next/standalone tree
 *                                    (server.js, server/cabinet-daemon.cjs,
 *                                    bin/node, .native/, .seed/, documents/)
 *     Resources/cabinet-icon.icns
 *
 * Keeping the Chromium binary inside this bundle (rather than a nested .app)
 * makes Cabinet.app its mainBundle — one Dock icon, "Cabinet" in the menu bar,
 * no second Chromium tile.
 *
 * Usage:
 *   node scripts/package-chromium-app.mjs \
 *     [--chromium-app /path/to/Chromium.app] \
 *     [--standalone /path/to/standalone] \
 *     [--out /path/to/Cabinet.app] \
 *     [--no-build]
 *
 * By default this runs `npm run build` + `npm run electron:prep` first so the
 * staged .next/standalone tree always matches the current sources — a stale
 * standalone silently ships an outdated daemon (host-mode args and all).
 * --no-build skips that for iteration when the tree is already current.
 *
 * Prerequisites:
 *   cabinet-chromium/scripts/build.sh release (produces out/release/Chromium.app)
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, cpSync, rmSync, readFileSync, writeFileSync, readdirSync, realpathSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const chromiumApp = resolve(
  arg(
    "chromium-app",
    join(
      process.env.CABINET_CHROMIUM_SRC || join(process.env.HOME, "chromium"),
      "src",
      "out",
      "release",
      "Chromium.app",
    ),
  ),
);
const standalone = resolve(
  arg("standalone", join(projectRoot, ".next", "standalone")),
);
const outApp = resolve(arg("out", join(projectRoot, "dist", "Cabinet.app")));

const BUNDLE_ID = "com.runcabinet.cabinet";
const skipBuild = process.argv.includes("--no-build");

function die(msg) {
  console.error(`package-chromium-app: ${msg}`);
  process.exit(1);
}
function sh(cmd, args) {
  execFileSync(cmd, args, { stdio: "inherit", cwd: projectRoot });
}
function plistSet(plist, key, type, value) {
  try {
    execFileSync("/usr/libexec/PlistBuddy", [
      "-c", `Set :${key} ${value}`, plist,
    ], { stdio: "pipe" });
  } catch {
    execFileSync("/usr/libexec/PlistBuddy", [
      "-c", `Add :${key} ${type} ${value}`, plist,
    ], { stdio: "inherit" });
  }
}
function plistDelete(plist, key) {
  try {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Delete :${key}`, plist], {
      stdio: "pipe",
    });
  } catch {
    // absent — fine
  }
}

// --- build the standalone tree ----------------------------------------------

if (!skipBuild) {
  console.log("==> building Next standalone + daemon bundle");
  sh("npm", ["run", "build"]);
  sh("npm", ["run", "electron:prep"]);
}

// --- verify inputs ----------------------------------------------------------

if (!existsSync(join(chromiumApp, "Contents", "MacOS", "Chromium"))) {
  die(`no Chromium.app at ${chromiumApp} — build the fork first (build.sh release)`);
}
for (const rel of [
  "server.js",
  join("server", "cabinet-daemon.cjs"),
  join("bin", "node"),
]) {
  if (!existsSync(join(standalone, rel))) {
    die(`standalone tree missing ${rel} — run npm run build && npm run electron:prep`);
  }
}
// Staleness guard: the packaged daemon must understand browser host mode.
// (An older staged build launches Chromium without --cabinet-ui-url and the
// app boots a plain Chromium window instead of the Cabinet shell.)
const daemonBundle = readFileSync(join(standalone, "server", "cabinet-daemon.cjs"), "utf8");
if (!daemonBundle.includes("cabinet-ui-url")) {
  die("staged cabinet-daemon.cjs lacks host-mode support — the standalone build is stale; drop --no-build");
}
if (!existsSync(join(standalone, ".native", "node-pty"))) {
  die("standalone tree missing .native/node-pty — run npm run electron:prep");
}

// --- assemble ---------------------------------------------------------------

console.log(`==> copying ${chromiumApp}`);
rmSync(outApp, { recursive: true, force: true });
mkdirSync(dirname(outApp), { recursive: true });
// ditto preserves the framework symlink structure exactly.
sh("ditto", [chromiumApp, outApp]);

const contents = join(outApp, "Contents");
const plist = join(contents, "Info.plist");

console.log("==> rewriting Info.plist");
plistSet(plist, "CFBundleExecutable", "string", "Cabinet");
plistSet(plist, "CFBundleName", "string", "Cabinet");
plistSet(plist, "CFBundleDisplayName", "string", "Cabinet");
plistSet(plist, "CFBundleIdentifier", "string", BUNDLE_ID);
plistSet(plist, "CFBundleIconFile", "string", "cabinet-icon");
plistSet(plist, "NSHumanReadableCopyright", "string", "Cabinet");
// Keystone/Sparkle keys advertise Chromium's updater; Cabinet ships its own.
for (const key of ["KSProductID", "KSVersion", "KSChannelID", "KSUpdateURL"]) {
  plistDelete(plist, key);
}

console.log("==> building launcher SEA");
sh(process.execPath, [
  join(projectRoot, "scripts", "build-launcher-sea.mjs"),
  "--out",
  join(contents, "MacOS"),
]);

console.log("==> staging standalone app tree");
// verbatimSymlinks: Next's output tracing emits RELATIVE dedup links in
// .next/node_modules (<pkg>-<hash> -> ../../node_modules/<pkg>) which resolve
// fine inside the bundle — but cpSync's default rewrites them to absolute
// source paths, leaking the build dir into the shipped app and breaking on
// any other machine. Copying the link text verbatim keeps them in-bundle.
cpSync(standalone, join(contents, "Resources", "app"), {
  recursive: true,
  verbatimSymlinks: true,
});

// Guard: no symlink inside Resources/app may resolve to a path outside the
// bundle. Catches leaks from any staging step, not just the one above.
const stagedApp = join(contents, "Resources", "app");
for (const entry of readdirSync(stagedApp, { recursive: true, withFileTypes: true })) {
  const p = join(entry.parentPath ?? stagedApp, entry.name);
  if (!entry.isSymbolicLink()) continue;
  let target;
  try {
    target = realpathSync(p);
  } catch {
    die(`staged symlink is dangling: ${p} -> ${readlinkSync(p)}`);
  }
  if (!target.startsWith(stagedApp)) {
    die(`staged symlink escapes the bundle: ${p} -> ${target}`);
  }
}

const icon = join(projectRoot, "electron", "assets", "cabinet-icon.icns");
if (existsSync(icon)) {
  cpSync(icon, join(contents, "Resources", "cabinet-icon.icns"));
} else {
  console.warn("package-chromium-app: no cabinet-icon.icns — icon unchanged");
}

// Ad-hoc sign the whole bundle so Gatekeeper permits local runs. Real
// Developer ID signing + notarization is a separate release step.
console.log("==> ad-hoc signing");
try {
  sh("codesign", ["--force", "--deep", "--sign", "-", outApp]);
} catch {
  console.warn("package-chromium-app: ad-hoc codesign failed — continuing (dev only)");
}

console.log(`\n==> ${outApp}`);
console.log("Run it with:  open " + outApp);
