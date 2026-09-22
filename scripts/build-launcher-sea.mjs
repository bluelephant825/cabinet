#!/usr/bin/env node
/**
 * Build the packaged launcher's executable: a Node single-executable
 * application (SEA) embedding launcher/cabinet-launcher.cjs.
 *
 * Output: <out>/Cabinet — a Mach-O binary that runs the supervisor script
 * with no arguments, suitable as Cabinet.app/Contents/MacOS/Cabinet.
 *
 * Usage: node scripts/build-launcher-sea.mjs [--out <dir>]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const outIdx = process.argv.indexOf("--out");
const outDir = resolve(
  outIdx >= 0 ? process.argv[outIdx + 1] : join(projectRoot, "out", "launcher"),
);
mkdirSync(outDir, { recursive: true });

const seaConfig = {
  main: join(projectRoot, "launcher", "cabinet-launcher.cjs"),
  output: join(outDir, "sea-prep.blob"),
  disableExperimentalSEAWarning: true,
  // No V8 snapshot: the launcher is a supervisor, startup ms don't matter and
  // snapshots add cross-platform fragility.
  useSnapshot: false,
  useCodeCache: false,
};

const configPath = join(outDir, "sea-config.json");
writeFileSync(configPath, JSON.stringify(seaConfig, null, 2));

execFileSync(process.execPath, ["--experimental-sea-config", configPath], {
  stdio: "inherit",
});

const target = join(outDir, "Cabinet");
copyFileSync(process.execPath, target);

// The copied node binary is signed for its own identity; inject requires a
// fresh (here ad-hoc) signature afterwards.
try {
  execFileSync("codesign", ["--remove-signature", target], { stdio: "inherit" });
} catch {
  // unsigned / ad-hoc already — fine
}

const postject = join(projectRoot, "node_modules", ".bin", "postject");
if (!existsSync(postject)) {
  throw new Error("postject not found — run npm install first");
}
execFileSync(
  postject,
  [
    target,
    "NODE_SEA_BLOB",
    seaConfig.output,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    "--macho-segment-name",
    "NODE_SEA",
  ],
  { stdio: "inherit" },
);

rmSync(seaConfig.output, { force: true });
rmSync(configPath, { force: true });

try {
  execFileSync("codesign", ["--force", "--sign", "-", target], { stdio: "inherit" });
} catch {
  // ad-hoc sign is best-effort pre-notarization
}

console.log(`launcher SEA written to ${target}`);
