import fs from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const target = path.join(root, "resources", "documents", "genoffice");

function sourceCandidates() {
  const candidates = [];
  if (process.env.CABINET_GENOFFICE_PREBUILT?.trim()) {
    candidates.push(process.env.CABINET_GENOFFICE_PREBUILT.trim());
  }
  if (process.platform === "darwin") {
    candidates.push(
      "/Applications/GenOffice.app/Contents/Resources",
      path.join(os.homedir(), "Applications", "GenOffice.app", "Contents", "Resources"),
    );
  } else if (process.platform === "win32") {
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "GenOffice", "resources"));
    }
  } else {
    candidates.push("/opt/GenOffice/resources");
  }
  return candidates;
}

function resolveSource(candidate) {
  if (!existsSync(candidate)) return null;
  const stat = statSync(candidate);
  if (stat.isFile() && path.basename(candidate) === "genoffice.cjs") {
    return { cli: path.dirname(candidate), resources: path.dirname(path.dirname(candidate)) };
  }
  if (!stat.isDirectory()) return null;
  if (existsSync(path.join(candidate, "cli", "genoffice.cjs"))) {
    return { cli: path.join(candidate, "cli"), resources: candidate };
  }
  if (existsSync(path.join(candidate, "genoffice.cjs"))) {
    return { cli: candidate, resources: path.dirname(candidate) };
  }
  return null;
}

const source = sourceCandidates().map(resolveSource).find(Boolean);
if (!source) {
  await fs.rm(target, { recursive: true, force: true });
  throw new Error(
    "GenOffice CLI prebuilt not found; set CABINET_GENOFFICE_PREBUILT or install GenOffice before packaging.",
  );
}

await fs.rm(target, { recursive: true, force: true });
await fs.mkdir(target, { recursive: true });
await fs.cp(source.cli, path.join(target, "cli"), { recursive: true, force: true });
const wasm = path.join(source.resources, "wasm", "pdfium.wasm");
if (existsSync(wasm)) {
  await fs.mkdir(path.join(target, "wasm"), { recursive: true });
  await fs.copyFile(wasm, path.join(target, "wasm", "pdfium.wasm"));
}
const notices = path.join(source.resources, "THIRD-PARTY-NOTICES.txt");
if (existsSync(notices)) {
  await fs.copyFile(notices, path.join(target, "THIRD-PARTY-NOTICES.txt"));
}
await fs.writeFile(
  path.join(target, "CABINET_BUILD.json"),
  `${JSON.stringify({ upstreamCommit: "476e5023c9a4bc459ca6de7b1d697ab25d94850e", stagedAt: new Date().toISOString() }, null, 2)}\n`,
);
console.log(`[genoffice-cli] staged ${source.cli} → ${path.join(target, "cli")}`);
