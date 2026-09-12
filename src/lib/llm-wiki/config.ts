import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import yaml from "js-yaml";
import { CABINET_MANIFEST_FILE } from "@/lib/cabinets/files";
import { writeFileAtomic } from "@/lib/storage/fs-operations";
import type { CabinetContext, CabinetId } from "./types";
import { contains, ownedPath, record, relativePath, statOrNull, withRootLock } from "./filesystem";

export const WIKI_STATE_PATH = ".cabinet-state/llm-wiki";

export interface WikiConfig {
  schemaVersion: 1;
  cabinetId: CabinetId;
  enabled: boolean;
  autoIngestInbox: boolean;
  paths: { inbox: string; raw: string; wiki: string };
}

export interface WikiCabinet extends CabinetContext {
  readonly config: WikiConfig;
}

export function opaqueId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Invalid LLM Wiki identity");
  }
  return value;
}

export function parseConfig(value: unknown): WikiConfig {
  const data = record(value);
  const paths = record(data.paths);
  if (data.schemaVersion !== 1 || typeof data.enabled !== "boolean" ||
      typeof data.autoIngestInbox !== "boolean") throw new Error("Unsupported or invalid LLM Wiki config");
  const normalized = {
    inbox: relativePath(paths.inbox), raw: relativePath(paths.raw), wiki: relativePath(paths.wiki),
  };
  const values = Object.values(normalized);
  for (const candidate of values) {
    if (candidate.split("/").some((part) => part.startsWith("."))) {
      throw new Error("LLM Wiki content paths cannot use hidden directories");
    }
  }
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      if (contains(values[i], values[j]) || contains(values[j], values[i])) {
        throw new Error("Inbox, Raw and Wiki paths must not overlap");
      }
    }
  }
  return {
    schemaVersion: 1, cabinetId: opaqueId(data.cabinetId) as CabinetId,
    enabled: data.enabled, autoIngestInbox: data.autoIngestInbox, paths: normalized,
  };
}

async function manifest(root: string) {
  const target = await ownedPath(root, CABINET_MANIFEST_FILE);
  const raw = await fs.readFile(target, "utf8");
  const data = record(yaml.load(raw, { schema: yaml.JSON_SCHEMA }));
  // Rooms and child cabinets must not acquire a second root-domain identity.
  if (data.kind !== "root") throw new Error("LLM Wiki requires an existing root Cabinet");
  return { target, raw, data };
}

export async function readWikiCabinet(rootPath: string): Promise<WikiCabinet | null> {
  const root = await fs.realpath(rootPath);
  const { data } = await manifest(root);
  if (data.llmWiki === undefined) return null;
  const config = parseConfig(data.llmWiki);
  for (const relative of [...Object.values(config.paths), WIKI_STATE_PATH]) {
    const target = await ownedPath(root, relative);
    const stat = await statOrNull(target);
    if (stat && !stat.isDirectory()) throw new Error(`Expected directory: ${relative}`);
  }
  return { rootPath: root, cabinetId: config.cabinetId, config };
}

/** Explicit opt-in configuration only. Nothing invokes this at app startup. */
export async function initializeWikiCabinet(
  rootPath: string,
  options: { paths?: Partial<WikiConfig["paths"]>; enabled?: boolean } = {},
): Promise<WikiCabinet> {
  const root = await fs.realpath(rootPath);
  return withRootLock(root, async () => {
    const existing = await readWikiCabinet(root);
    if (existing) {
      if ((options.enabled !== undefined && options.enabled !== existing.config.enabled) ||
          Object.entries(options.paths ?? {}).some(([key, value]) =>
            existing.config.paths[key as keyof WikiConfig["paths"]] !== value)) {
        throw new Error("Initialization cannot reconfigure an existing LLM Wiki");
      }
      return existing;
    }
    const current = await manifest(root);
    const config = parseConfig({
      schemaVersion: 1, cabinetId: randomUUID(), enabled: options.enabled ?? false,
      autoIngestInbox: false,
      paths: { inbox: "Inbox", raw: "raw", wiki: "wiki", ...options.paths },
    });
    // Inspect every destination before writing anything. No adoption of unknown
    // Raw/Wiki/state contents, no moving existing vault files.
    for (const relative of [...Object.values(config.paths), WIKI_STATE_PATH]) {
      const target = await ownedPath(root, relative);
      const stat = await statOrNull(target);
      if (stat && !stat.isDirectory()) throw new Error(`Expected directory: ${relative}`);
      if (stat && relative !== config.paths.inbox && (await fs.readdir(target)).length) {
        throw new Error(`Refusing to adopt nonempty directory: ${relative}`);
      }
    }
    if (await fs.readFile(current.target, "utf8") !== current.raw) {
      throw new Error("Cabinet manifest changed during initialization; retry");
    }
    await writeFileAtomic(current.target, yaml.dump({ ...current.data, llmWiki: config }, { lineWidth: -1 }));
    return { rootPath: root, cabinetId: config.cabinetId, config };
  });
}

/** Change only the feature gate, preserving unknown manifest/config metadata. */
export async function setWikiEnabled(rootPath: string, enabled: boolean): Promise<WikiCabinet> {
  if (typeof enabled !== "boolean") throw new Error("Expected boolean feature flag");
  return patchWikiFlags(rootPath, { enabled });
}

export async function setAutoIngestInbox(rootPath: string, autoIngestInbox: boolean): Promise<WikiCabinet> {
  if (typeof autoIngestInbox !== "boolean") throw new Error("Expected boolean auto-ingest flag");
  return patchWikiFlags(rootPath, { autoIngestInbox });
}

async function patchWikiFlags(rootPath: string, patch: Partial<Pick<WikiConfig, "enabled" | "autoIngestInbox">>): Promise<WikiCabinet> {
  const root = await fs.realpath(rootPath);
  return withRootLock(root, async () => {
    const cabinet = await readWikiCabinet(root);
    if (!cabinet) throw new Error("LLM Wiki has not been initialized");
    const current = await manifest(root);
    const config = { ...record(current.data.llmWiki), ...patch };
    parseConfig(config);
    await writeFileAtomic(current.target, yaml.dump({ ...current.data, llmWiki: config }, { lineWidth: -1 }));
    return { ...cabinet, config: parseConfig(config) };
  });
}
