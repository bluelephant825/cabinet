import { getDb } from "../db";
import { DATA_DIR } from "../../src/lib/storage/path-utils";
import { readWikiCabinet } from "../../src/lib/llm-wiki/config";
import { IngestionQueue } from "../../src/lib/llm-wiki/queue";

/** Daemon queue entry point shared by watchers; no automatic job processing. */
export async function openActiveIngestionQueue(): Promise<IngestionQueue | null> {
  const cabinet = await readWikiCabinet(DATA_DIR);
  if (!cabinet || !cabinet.config.enabled) return null;
  const queue = await IngestionQueue.open(getDb(), DATA_DIR);
  queue.recoverExpired();
  return queue;
}
