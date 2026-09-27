import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "node:os";
import path from "path";
import { execFileSync } from "node:child_process";
import { DATA_DIR, DATA_PARENT_DIR } from "../src/lib/storage/path-utils";
import { ensureCabinetsMigrated, listCabinets } from "../src/lib/cabinets/cabinets";
import {
  scaffoldCabinet,
  seedGettingStartedDir,
} from "../src/lib/storage/cabinet-scaffold";

function uniqueCabinetPath(prefix: string): string {
  return path.join(
    DATA_DIR,
    `__${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
}

test("scaffoldCabinet seeds getting-started docs into new cabinets", async () => {
  const targetDir = uniqueCabinetPath("scaffold-getting-started");

  try {
    await fs.mkdir(targetDir, { recursive: true });

    await scaffoldCabinet(targetDir, {
      name: "Scaffold Seed Test",
      kind: "child",
    });

    await fs.access(path.join(targetDir, "getting-started", "index.md"));
    await fs.access(
      path.join(targetDir, "getting-started", "apps-and-repos", "index.md")
    );
  } finally {
    await fs.rm(targetDir, { recursive: true, force: true });
  }
});

test("legacy cabinet with a nested Cabinet manifest remains switchable", async () => {
  const name = `__legacy-root-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const root = path.join(DATA_PARENT_DIR, name);
  try {
    await fs.mkdir(path.join(root, ".home"), { recursive: true });
    await fs.writeFile(path.join(root, ".home", "home.json"), "{}\n");
    await fs.mkdir(path.join(root, "Cabinet", "wiki"), { recursive: true });
    await fs.writeFile(path.join(root, "Cabinet", ".cabinet"), "kind: root\n");
    await fs.writeFile(path.join(root, "Cabinet", "wiki", "index.md"), "# Wiki\n");
    assert.ok((await listCabinets()).some((cabinet) => cabinet.name === name));
    await ensureCabinetsMigrated();
    assert.match(await fs.readFile(path.join(root, ".cabinet"), "utf8"), /kind: root/);
    assert.equal(await fs.readFile(path.join(root, "Cabinet", "wiki", "index.md"), "utf8"), "# Wiki\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("mispointed data dir cannot nest an existing cabinet during startup migration", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-root-guard-"));
  const cabinet = path.join(parent, "My Study");
  const manifest = "schemaVersion: 1\nid: my-study-root\nkind: root\nentry: index.md\nllmWiki:\n  enabled: true\n";
  try {
    await fs.mkdir(path.join(parent, ".home"), { recursive: true });
    await fs.writeFile(path.join(parent, ".home", "home.json"), JSON.stringify({ activeCabinet: "My Study" }));
    await fs.mkdir(path.join(cabinet, "Notes"), { recursive: true });
    await fs.writeFile(path.join(cabinet, ".cabinet"), manifest);
    await fs.writeFile(path.join(cabinet, "Notes", "page.md"), "# Keep me\n");
    const output = execFileSync(process.execPath, ["--import", "tsx", "--eval", `
      const { getManagedDataParentDir } = require("./src/lib/runtime/runtime-config.ts");
      const { ensureCabinetsMigrated } = require("./src/lib/cabinets/cabinets.ts");
      ensureCabinetsMigrated().then(() => console.log(getManagedDataParentDir()));
    `], { cwd: process.cwd(), env: { ...process.env, CABINET_DATA_DIR: cabinet }, encoding: "utf8" });
    assert.equal(output.trim(), parent);
    assert.equal(await fs.readFile(path.join(cabinet, ".cabinet"), "utf8"), manifest);
    assert.equal(await fs.readFile(path.join(cabinet, "Notes", "page.md"), "utf8"), "# Keep me\n");
    await assert.rejects(fs.access(path.join(cabinet, "Cabinet")), { code: "ENOENT" });
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("an existing cabinet without a matching parent pointer fails closed", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-root-guard-"));
  const cabinet = path.join(parent, "My Study");
  try {
    await fs.mkdir(path.join(parent, ".home"), { recursive: true });
    await fs.writeFile(path.join(parent, ".home", "home.json"), JSON.stringify({ activeCabinet: "Other" }));
    await fs.mkdir(path.join(cabinet, "Notes"), { recursive: true });
    await fs.writeFile(path.join(cabinet, ".cabinet"), "kind: root\n");
    await fs.writeFile(path.join(cabinet, "Notes", "page.md"), "# Keep me\n");
    assert.throws(() => execFileSync(process.execPath, ["--import", "tsx", "--eval", `
      const { ensureCabinetsMigrated } = require("./src/lib/cabinets/cabinets.ts");
      ensureCabinetsMigrated();
    `], { cwd: process.cwd(), env: { ...process.env, CABINET_DATA_DIR: cabinet }, stdio: "pipe" }));
    assert.equal(await fs.readFile(path.join(cabinet, "Notes", "page.md"), "utf8"), "# Keep me\n");
    await assert.rejects(fs.access(path.join(cabinet, "Cabinet")), { code: "ENOENT" });
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("a direct cabinet data dir remains usable without nesting it", async () => {
  const cabinet = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-direct-root-"));
  const manifest = "schemaVersion: 1\nkind: root\nentry: index.md\n";
  try {
    await fs.writeFile(path.join(cabinet, ".cabinet"), manifest);
    await fs.writeFile(path.join(cabinet, "index.md"), "# Direct root\n");
    const output = execFileSync(process.execPath, ["--import", "tsx", "--eval", `
      const { getManagedDataDir } = require("./src/lib/runtime/runtime-config.ts");
      const { ensureCabinetsMigrated } = require("./src/lib/cabinets/cabinets.ts");
      ensureCabinetsMigrated().then(() => console.log(getManagedDataDir()));
    `], { cwd: process.cwd(), env: { ...process.env, CABINET_DATA_DIR: cabinet }, encoding: "utf8" });
    assert.equal(output.trim(), cabinet);
    assert.equal(await fs.readFile(path.join(cabinet, ".cabinet"), "utf8"), manifest);
    await assert.rejects(fs.access(path.join(cabinet, "Cabinet")), { code: "ENOENT" });
  } finally {
    await fs.rm(cabinet, { recursive: true, force: true });
  }
});

test("missing active cabinet manifest cannot trigger migration of its content", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-missing-manifest-"));
  const cabinet = path.join(parent, "My Study");
  try {
    await fs.mkdir(path.join(parent, ".home"), { recursive: true });
    await fs.writeFile(path.join(parent, ".home", "home.json"), JSON.stringify({ activeCabinet: "My Study" }));
    await fs.mkdir(path.join(cabinet, ".cabinet-state"), { recursive: true });
    await fs.mkdir(path.join(cabinet, "Notes"), { recursive: true });
    await fs.writeFile(path.join(cabinet, "index.md"), "# My Study\n");
    await fs.writeFile(path.join(cabinet, "Notes", "page.md"), "# Keep me\n");
    assert.throws(() => execFileSync(process.execPath, ["--import", "tsx", "--eval", `
      const { ensureCabinetsMigrated } = require("./src/lib/cabinets/cabinets.ts");
      ensureCabinetsMigrated();
    `], { cwd: process.cwd(), env: { ...process.env, CABINET_DATA_DIR: parent }, stdio: "pipe" }));
    assert.equal(await fs.readFile(path.join(cabinet, "Notes", "page.md"), "utf8"), "# Keep me\n");
    await assert.rejects(fs.access(path.join(parent, "Cabinet")), { code: "ENOENT" });
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("scaffoldCabinet skipExisting preserves existing ownership metadata", async () => {
  const targetDir = uniqueCabinetPath("scaffold-preserve-manifest");
  const manifest = "kind: root\nllmWiki:\n  enabled: true\n";
  try {
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, ".cabinet"), manifest);
    await scaffoldCabinet(targetDir, { name: "Existing", kind: "root", skipExisting: true });
    assert.equal(await fs.readFile(path.join(targetDir, ".cabinet"), "utf8"), manifest);
  } finally {
    await fs.rm(targetDir, { recursive: true, force: true });
  }
});

test("seedGettingStartedDir preserves existing docs while filling missing files", async () => {
  const targetDir = uniqueCabinetPath("merge-getting-started");
  const customContent = "# Custom getting started\n";
  const existingIndexPath = path.join(targetDir, "getting-started", "index.md");

  try {
    await fs.mkdir(path.dirname(existingIndexPath), { recursive: true });
    await fs.writeFile(existingIndexPath, customContent, "utf-8");

    await seedGettingStartedDir(targetDir);

    const actual = await fs.readFile(existingIndexPath, "utf-8");
    assert.equal(actual, customContent);

    await fs.access(
      path.join(
        targetDir,
        "getting-started",
        "symlinks-and-load-knowledge",
        "index.md"
      )
    );
  } finally {
    await fs.rm(targetDir, { recursive: true, force: true });
  }
});
