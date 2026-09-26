#!/usr/bin/env node
/**
 * Release pipeline for the Chromium-hosted Cabinet.app:
 * fork release build → package → ditto zip → GitHub draft release.
 *
 * Usage:
 *   node scripts/release-chromium-app.mjs [options]
 *
 * Options:
 *   --version <v>        Version string used in the asset name
 *                        (default: package.json version)
 *   --tag <tag>          GitHub release tag (default: v<version>)
 *   --repo <owner/repo>  Target repository (default: bluelephant825/cabinet)
 *   --chromium-app <p>   Fork .app to package (default:
 *                        $CABINET_CHROMIUM_SRC/src/out/release/Chromium.app)
 *   --out <dir>          Output dir for Cabinet.app + zip (default: dist/)
 *   --skip-build         Skip `cabinet-chromium/scripts/build.sh release`
 *   --publish            Publish immediately instead of creating a draft
 *   --dry-run            Print every step without executing
 *
 * The release is always created as a draft unless --publish is given — eyeball
 * the notes and asset on GitHub, then publish with:
 *   gh release edit <tag> --repo <repo> --draft=false
 *
 * The zip is ad-hoc signed. The release notes tell users to strip the
 * quarantine attribute after downloading — right-click → Open does NOT bypass
 * the "damaged" dialog for unsigned apps:
 *   xattr -dr com.apple.quarantine /Applications/Cabinet.app
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

const pkg = JSON.parse(
  readFileSync(join(projectRoot, "package.json"), "utf8"),
);
const version = arg("version", pkg.version);
const tag = arg("tag", `v${version}`);
const repo = arg("repo", "bluelephant825/cabinet");
const outDir = resolve(arg("out", join(projectRoot, "dist")));
const chromiumSrc = process.env.CABINET_CHROMIUM_SRC || join(process.env.HOME, "chromium");
const chromiumApp = resolve(
  arg("chromium-app", join(chromiumSrc, "src", "out", "release", "Chromium.app")),
);
const chromiumRepo = resolve(
  arg("chromium-repo", join(projectRoot, "..", "cabinet-chromium")),
);
const skipBuild = flag("skip-build");
const publish = flag("publish");
const dryRun = flag("dry-run");

const appPath = join(outDir, "Cabinet.app");
const zipName = `Cabinet-${version}-macos-arm64.zip`;
const zipPath = join(outDir, zipName);

function die(msg) {
  console.error(`release-chromium-app: ${msg}`);
  process.exit(1);
}
function sh(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  if (dryRun) return;
  execFileSync(cmd, args, { stdio: "inherit", cwd: projectRoot, ...opts });
}

// --- 1. release build of the fork -------------------------------------------

if (skipBuild) {
  console.log("==> skipping fork build (--skip-build)");
} else {
  console.log("==> building fork (release)");
  sh(join(chromiumRepo, "scripts", "build.sh"), ["release"]);
}
if (!dryRun && !existsSync(join(chromiumApp, "Contents", "MacOS", "Chromium"))) {
  die(`no Chromium.app at ${chromiumApp} — build the fork first`);
}

// --- 2. package -------------------------------------------------------------

console.log("==> packaging Cabinet.app");
sh(process.execPath, [
  join(projectRoot, "scripts", "package-chromium-app.mjs"),
  "--chromium-app",
  chromiumApp,
  "--out",
  appPath,
]);

// --- 3. zip -----------------------------------------------------------------
// `zip -ry` preserves the framework's symlink tree (-y); the ad-hoc signature
// lives in regular _CodeSignature files + embedded LC_CODE_SIGNATURE, so it
// survives. ditto --sequesterRsrc instead emits a __MACOSX/ AppleDouble
// sidecar per entry — 36k of them here — which non-Archive-Utility extractors
// leave behind as a bogus zero-byte __MACOSX/Cabinet.app next to the real app.
// Strip build-machine xattrs (com.apple.provenance lands on every file) first
// so none ride along in the archive.

console.log(`==> zipping ${zipName}`);
try {
  sh("xattr", ["-cr", appPath]);
} catch {
  console.warn("release-chromium-app: xattr strip failed — continuing");
}
sh("zip", ["-qry", zipPath, "Cabinet.app"], {
  cwd: dirname(appPath),
});

// --- 4. draft release --------------------------------------------------------

const notes = `## Cabinet ${tag} — Chromium-hosted build (macOS arm64)

The React/Next.js Cabinet shell hosted inside a Cabinet Chromium fork — real
tabs, real MV3 extensions, browser profiles, all inside one window. No Electron.

### Install

1. Download **${zipName}**, unzip, and move **Cabinet.app** to /Applications.
2. This build is ad-hoc signed (not notarized yet), so macOS will report it
   "damaged" until you strip the quarantine attribute — right-click → Open
   does **not** work for unsigned apps. Run:

   \`\`\`bash
   xattr -dr com.apple.quarantine /Applications/Cabinet.app
   \`\`\`

3. Launch normally. Quitting the browser window exits the whole app.

### Notes

- Chromium ${safeChromiumVersion()} · Cabinet ${version}
- macOS arm64 only for now.
`;

function safeChromiumVersion() {
  try {
    return readFileSync(
      join(chromiumRepo, "CHROMIUM_VERSION"), "utf8",
    ).trim();
  } catch {
    return "(unknown)";
  }
}

console.log(`==> creating ${publish ? "release" : "draft release"} ${tag} on ${repo}`);
const ghArgs = [
  "release", "create", tag, zipPath,
  "--repo", repo,
  "--title", `Cabinet ${tag}`,
  "--notes", notes,
];
if (!publish) ghArgs.push("--draft");
sh("gh", ghArgs);

if (dryRun) {
  console.log("\n(dry run — nothing executed)");
} else {
  console.log(`\n==> done. Review and publish:  gh release edit ${tag} --repo ${repo} --draft=false`);
}
