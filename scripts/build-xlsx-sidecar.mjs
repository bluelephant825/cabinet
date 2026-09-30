#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const engine = path.join(root, "src/vendor/genoffice/apps/sheets/native/xlsx-engine");
const manifest = path.join(engine, "Cargo.toml");
const cargoConfig = path.join(engine, ".cargo/config.toml");
const targetDir = path.join(root, "build", "xlsx-sidecar-target");
const platform = process.env.CABINET_ELECTRON_TARGET_PLATFORM || process.platform;
const arch = process.env.CABINET_ELECTRON_TARGET_ARCH || process.arch;
const suffix = platform === "win32" ? ".exe" : "";
const output = path.join(
  root,
  "resources",
  "documents",
  "xlsx",
  `${platform}-${arch}`,
  `xlsx-sidecar${suffix}`,
);

await fs.mkdir(path.dirname(output), { recursive: true });
const prebuilt = process.env.CABINET_XLSX_SIDECAR_PREBUILT?.trim();
if (prebuilt) {
  await fs.copyFile(prebuilt, output);
  if (platform !== "win32") await fs.chmod(output, 0o755);
  console.log(`[xlsx-sidecar] staged prebuilt ${platform}-${arch} → ${output}`);
  process.exit(0);
}

const env = { ...process.env, CARGO_TARGET_DIR: targetDir };
if (platform === "darwin" && process.env.CABINET_XLSX_UNIVERSAL === "1") {
  if (process.platform !== "darwin") {
    throw new Error("CABINET_XLSX_UNIVERSAL requires a macOS build host");
  }
  const targets = ["x86_64-apple-darwin", "aarch64-apple-darwin"];
  for (const target of targets) {
    execFileSync(
      "cargo",
      [
        "build",
        "--release",
        "--manifest-path",
        manifest,
        "--config",
        cargoConfig,
        "--target",
        target,
      ],
      { cwd: root, env, stdio: "inherit" },
    );
  }
  execFileSync(
    "lipo",
    [
      "-create",
      ...targets.map((target) => path.join(targetDir, target, "release", "xlsx-sidecar")),
      "-output",
      output,
    ],
    { stdio: "inherit" },
  );
  await fs.chmod(output, 0o755);
  console.log(`[xlsx-sidecar] built universal macOS binary → ${output}`);
  process.exit(0);
}

if (platform !== process.platform || arch !== process.arch) {
  throw new Error(
    `Cross-packaging XLSX for ${platform}-${arch} requires CABINET_XLSX_SIDECAR_PREBUILT`,
  );
}

execFileSync(
  "cargo",
  ["build", "--release", "--manifest-path", manifest, "--config", cargoConfig],
  { cwd: root, env, stdio: "inherit" },
);
const built = path.join(targetDir, "release", `xlsx-sidecar${suffix}`);
await fs.copyFile(built, output);
if (platform !== "win32") await fs.chmod(output, 0o755);
console.log(`[xlsx-sidecar] built ${os.platform()}-${os.arch()} → ${output}`);
