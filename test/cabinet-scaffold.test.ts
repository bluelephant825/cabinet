import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";
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
