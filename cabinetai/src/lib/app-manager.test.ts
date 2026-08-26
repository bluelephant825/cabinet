import test, { before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The module reads `CABINET_HOME` from `~/.cabinet` at import time (via
// `paths.ts`). Redirect HOME to a temp dir before importing so the test
// filesystem is isolated from a real developer install.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cabinet-app-manager-test-"));
process.env.HOME = tmpHome;
if (process.platform === "win32") {
  process.env.USERPROFILE = tmpHome;
}

let mod: typeof import("./app-manager");
let appDir: string;

before(async () => {
  mod = await import("./app-manager.js");
  const paths = await import("./paths.js");
  appDir = path.join(paths.CABINET_HOME, "app");
});

// Simulate a fully-installed prebuilt bundle for a given version — every check
// in `hasProductionRuntime` must pass or `isAppInstalled` filters the version
// out.
function seedInstalledBundle(version: string): void {
  const versionDir = path.join(appDir, `v${version}`);
  fs.mkdirSync(path.join(versionDir, ".next", "static"), { recursive: true });
  fs.mkdirSync(path.join(versionDir, "server"), { recursive: true });
  fs.mkdirSync(path.join(versionDir, ".native", "node-pty"), { recursive: true });
  fs.writeFileSync(path.join(versionDir, "server.js"), "// stub");
  fs.writeFileSync(path.join(versionDir, "server", "cabinet-daemon.cjs"), "// stub");
  fs.writeFileSync(
    path.join(versionDir, ".native", "node-pty", "package.json"),
    "{}"
  );
}

// A half-installed directory: created (e.g. by a failed download) but nothing
// runnable inside. `listInstalledVersions()` still sees it; `isAppInstalled`
// rejects it.
function seedPartialInstall(version: string): void {
  fs.mkdirSync(path.join(appDir, `v${version}`), { recursive: true });
}

function clearApps(): void {
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.mkdirSync(appDir, { recursive: true });
}

test.beforeEach(() => clearApps());

test("compareSemver orders release versions numerically, not lexicographically", () => {
  const { compareSemver } = mod;
  assert.ok(compareSemver("0.4.10", "0.4.9") > 0, "0.4.10 must sort after 0.4.9");
  assert.ok(compareSemver("0.5.0", "0.4.9") > 0);
  assert.equal(compareSemver("0.4.3", "0.4.3"), 0);
  assert.ok(compareSemver("0.4.2", "0.4.3") < 0);
  // Leading `v` is tolerated so callers can pass version dir names directly.
  assert.equal(compareSemver("v0.4.3", "0.4.3"), 0);
});

test("latestInstalledVersion returns null when no app is installed", () => {
  const { latestInstalledVersion } = mod;
  assert.equal(latestInstalledVersion(), null);
});

test("latestInstalledVersion returns the highest fully-installed semver", () => {
  const { latestInstalledVersion } = mod;
  seedInstalledBundle("0.4.2");
  seedInstalledBundle("0.4.3");
  seedInstalledBundle("0.4.10");
  assert.equal(latestInstalledVersion(), "0.4.10");
});

// The #97 scenario: `cabinetai update` downloaded v0.4.3 but `npm install`
// failed inside the fresh dir, leaving it half-installed. The user's CLI is
// still v0.4.2. `run` must NOT pick the broken v0.4.3 — it must fall back
// to VERSION (0.4.2) so the caller can either fix or wipe the partial dir.
test("latestInstalledVersion ignores half-installed version directories", () => {
  const { latestInstalledVersion } = mod;
  seedInstalledBundle("0.4.2");
  seedPartialInstall("0.4.3");
  assert.equal(latestInstalledVersion(), "0.4.2");
});

test("listInstalledVersions still surfaces partial installs (used by `cabinetai list`)", () => {
  const { listInstalledVersions } = mod;
  seedInstalledBundle("0.4.2");
  seedPartialInstall("0.4.3");
  assert.deepEqual(listInstalledVersions().sort(), ["0.4.2", "0.4.3"]);
});
