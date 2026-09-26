import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, DATA_PARENT_DIR } from "@/lib/storage/path-utils";
import { listRooms, resolveDefaultRoom, resolveReopen, setLastActive } from "./rooms";
import { isCabinetPath } from "./server-paths";

const homeDir = path.join(DATA_PARENT_DIR, ".home");
const folders = ["Inbox", "Notes", "raw", "wiki", "getting-started"];

test("root cabinet with ordinary content folders is usable without child rooms", async () => {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(homeDir, { recursive: true });
  await fs.writeFile(path.join(DATA_DIR, ".cabinet"), "name: My Study\nkind: root\nentry: index.md\n");
  for (const folder of folders) await fs.mkdir(path.join(DATA_DIR, folder), { recursive: true });
  await fs.writeFile(path.join(homeDir, "home.json"), JSON.stringify({ activeCabinet: path.basename(DATA_DIR) }));
  try {
    assert.deepEqual((await listRooms()).map((room) => room.path), ["."]);
    assert.equal((await listRooms())[0].name, "My Study");
    assert.equal(await isCabinetPath("Inbox"), false);
    assert.equal(await resolveDefaultRoom(), ".");
    await setLastActive("Inbox/Clip");
    assert.deepEqual(await resolveReopen(), { room: ".", path: "Inbox/Clip" });
    await fs.mkdir(path.join(DATA_DIR, "Work"));
    await fs.writeFile(path.join(DATA_DIR, "Work", ".cabinet"), "name: Work\nkind: room\n");
    assert.deepEqual((await listRooms()).map((room) => room.path), ["Work"]);
    await fs.rm(path.join(DATA_DIR, "Work"), { recursive: true });
  } finally {
    for (const folder of folders) await fs.rm(path.join(DATA_DIR, folder), { recursive: true, force: true });
    await fs.rm(path.join(DATA_DIR, ".cabinet"), { force: true });
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});
