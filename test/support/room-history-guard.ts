import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";

import { DATA_DIR } from "../../src/lib/storage/path-utils";

const HISTORY_CONFIG_PATH = path.join(DATA_DIR, ".cabinet-state", "history.json");

/**
 * Suspend room auto-commits for the duration of a test file.
 *
 * Direct `tsx --test` runs share DATA_DIR with a live app/daemon: the history
 * engine commits app-side mutations, and `commitAgentRun` sweeps the ENTIRE
 * dirty tree at each agent run's end — including stray test fixtures — into
 * the agent's commit. Flipping the room to `journalOnly` stops both paths
 * (events are still journaled, marked skipped). `test.before` snapshots the
 * existing config byte-for-byte (including "file absent") before flipping the
 * flag; `test.after` restores it in a `finally` so a failing or aborted test
 * can never leave the room journal-only.
 *
 * No-op-safe under `npm test`: the seeded tmp cabinet has no watcher anyway.
 */
export function suspendRoomHistoryCommits(): void {
  let backup: string | null = null;

  test.before(async () => {
    backup = await fs.readFile(HISTORY_CONFIG_PATH, "utf8").catch(() => null);
    let config: Record<string, unknown> = {};
    if (backup !== null) {
      try {
        config = JSON.parse(backup) as Record<string, unknown>;
      } catch {
        config = {};
      }
    }
    await fs.mkdir(path.dirname(HISTORY_CONFIG_PATH), { recursive: true });
    await fs.writeFile(
      HISTORY_CONFIG_PATH,
      JSON.stringify({ ...config, journalOnly: true }, null, 2) + "\n",
    );
  });

  test.after(async () => {
    try {
      if (backup === null) {
        await fs.rm(HISTORY_CONFIG_PATH, { force: true });
      } else {
        await fs.writeFile(HISTORY_CONFIG_PATH, backup);
      }
    } finally {
      backup = null;
    }
  });
}
