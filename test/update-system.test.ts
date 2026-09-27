import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { assertNoArchivedApps } from "../next.config";
import { compareVersions, isStableVersion } from "@/lib/system/version-utils";
import { readBundledReleaseManifest } from "@/lib/system/release-manifest";
import { detectInstallKind, inferElectronInstallKind } from "@/lib/system/install-metadata";
import type { InstallMetadata } from "@/types";

const pkgVersion = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf8")
).version as string;

test("production trace guard rejects archived apps without following their recursive contents", () => {
  const root = mkdtempSync(join(os.tmpdir(), "cabinet-trace-guard-"));
  try {
    mkdirSync(join(root, "dist", "Cabinet.app", "Contents", "Resources", "app", "dist", "Cabinet.app"), { recursive: true });
    assert.throws(() => assertNoArchivedApps(root), /dist\/Cabinet\.app/);
    rmSync(join(root, "dist"), { recursive: true });
    mkdirSync(join(root, "data-backup-old", "retired", "Old.app"), { recursive: true });
    assert.throws(() => assertNoArchivedApps(root), /data-backup-old/);
    rmSync(join(root, "data-backup-old"), { recursive: true });
    mkdirSync(join(root, ".next", "standalone", "dist", "Stale.app"), { recursive: true });
    assert.throws(() => assertNoArchivedApps(root), /\.next\/standalone/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production trace guard permits clean source and ignores node_modules fixtures", () => {
  const root = mkdtempSync(join(os.tmpdir(), "cabinet-trace-guard-"));
  try {
    mkdirSync(join(root, "node_modules", "fixture.app"), { recursive: true });
    mkdirSync(join(root, "dist", "documents"), { recursive: true });
    assert.doesNotThrow(() => assertNoArchivedApps(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compareVersions sorts stable semver values correctly", () => {
  assert.equal(compareVersions("0.2.0", "0.1.9"), 1);
  assert.equal(compareVersions("0.2.0", "0.2.0"), 0);
  assert.equal(compareVersions("0.1.9", "0.2.0"), -1);
});

test("isStableVersion only accepts plain stable semver", () => {
  assert.equal(isStableVersion("0.2.0"), true);
  assert.equal(isStableVersion("v0.2.0"), true);
  assert.equal(isStableVersion("0.2.0-beta.1"), false);
});

test("bundled release manifest stays aligned with the local package version", async () => {
  const manifest = await readBundledReleaseManifest();

  assert.equal(manifest.version, pkgVersion);
  assert.equal(manifest.gitTag, `v${pkgVersion}`);
  assert.equal(manifest.channel, "stable");
  assert.equal(manifest.createCabinetVersion, pkgVersion);
  assert.equal(manifest.cabinetaiVersion, pkgVersion);
  assert.match(manifest.releaseNotesUrl, new RegExp(`/tag/v${pkgVersion.replace(/\./g, "\\.")}$`));
  assert.match(manifest.sourceTarballUrl, new RegExp(`v${pkgVersion.replace(/\./g, "\\.")}\\.tar\\.gz$`));
});

test("detectInstallKind respects explicit environment hints first", () => {
  const original = process.env.CABINET_INSTALL_KIND;
  process.env.CABINET_INSTALL_KIND = "source-custom";

  try {
    const metadata: InstallMetadata = {
      installKind: "source-managed",
      managed: true,
      installedAt: new Date().toISOString(),
      currentVersion: "0.2.0",
      projectRoot: "/tmp/cabinet",
      dataDir: "/tmp/cabinet/data",
    };

    assert.equal(detectInstallKind(metadata), "source-custom");
  } finally {
    if (original === undefined) {
      delete process.env.CABINET_INSTALL_KIND;
    } else {
      process.env.CABINET_INSTALL_KIND = original;
    }
  }
});

test("inferElectronInstallKind maps Windows and macOS runtimes distinctly", () => {
  assert.equal(inferElectronInstallKind("win32"), "electron-windows");
  assert.equal(inferElectronInstallKind("darwin"), "electron-macos");
});
