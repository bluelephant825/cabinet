import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import cron from "node-cron";
import { DATA_DIR, resolveContentPath } from "../../src/lib/storage/path-utils";
import { listRooms } from "../../src/lib/cabinets/rooms";
import { assertWritablePath } from "../../src/lib/knowledge-sources/store";
import { writeFileAtomic } from "../../src/lib/storage/fs-operations";
import { emptyConfig, emptyCache, type RssConfig, type RssCache, type RssBriefRun, type RssRule, type RssBrief } from "../../src/lib/rss/types";
import { feedUrl } from "../../src/lib/rss/opml";

export class RssError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export const identifier = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new RssError("Invalid RSS identifier");
  return value;
};
export function relativeFolder(value: unknown): string {
  if (typeof value !== "string" || value.length > 500 || !value.trim() || value.includes("\\") || value.startsWith("/") || value.split("/").some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith(".") || /[\x00-\x1f:*?<>|]/.test(segment))) throw new RssError("Choose a normal folder inside this room");
  return value;
}
const string = (value: unknown, max: number) => typeof value === "string" && value.length <= max;
const strings = (value: unknown, max = 500): value is string[] => Array.isArray(value) && value.length <= max && value.every((item) => string(item, 500));
export function validateRule(rule: RssRule): void {
  if (!rule || typeof rule !== "object") throw new RssError("Invalid exclusion rule");
  identifier(rule.id);
  if (rule.enabled && rule.needsSelection) throw new RssError("Select sources again before enabling this rule");
  if (!string(rule.name, 200) || !rule.name.trim() || typeof rule.enabled !== "boolean" || !strings(rule.feedIds) || !strings(rule.folders) || !["all", "any"].includes(rule.mode) || !Array.isArray(rule.conditions) || !rule.conditions.length || rule.conditions.length > 20) throw new RssError("Invalid exclusion rule");
  for (const c of rule.conditions) {
    if (!c || typeof c !== "object") throw new RssError("Invalid rule condition");
    const textFields = ["title", "body", "author", "category", "language", "url", "domain"];
    const missing = ["is-missing", "is-present"];
    const allowed = textFields.includes(c.field) ? [...missing, "contains", "does-not-contain", "equals", "not-equals"] : c.field === "age" ? [...missing, "greater-than", "less-than"] : c.field === "date" ? [...missing, "before", "after"] : [];
    if (!allowed.includes(c.operator) || !string(c.value, 500) || (!missing.includes(c.operator) && !c.value.trim()) || (c.field === "age" && !missing.includes(c.operator) && (!Number.isFinite(Number(c.value)) || Number(c.value) < 0)) || (c.field === "date" && !missing.includes(c.operator) && !Number.isFinite(Date.parse(c.value)))) throw new RssError("Invalid rule condition");
  }
}
export function validateBrief(brief: RssBrief): void {
  if (!brief || typeof brief !== "object") throw new RssError("Invalid AI brief configuration");
  identifier(brief.id); identifier(brief.agentSlug);
  relativeFolder(brief.outputFolder);
  if (!string(brief.name, 200) || !brief.name.trim() || !string(brief.instructions, 10000) || !string(brief.schedule, 100) || !cron.validate(brief.schedule) || brief.schedule.trim().split(/\s+/).length !== 5 || typeof brief.enabled !== "boolean" || !strings(brief.feedIds) || !strings(brief.folders) || !Number.isInteger(brief.maxArticles) || brief.maxArticles < 1 || brief.maxArticles > 100 || !Number.isInteger(brief.maxBytes) || brief.maxBytes < 1000 || brief.maxBytes > 100000) throw new RssError("Invalid AI brief configuration");
}
export function validateConfig(value: RssConfig): void {
  if (!value || value.version !== 1 || !Number.isInteger(value.revision) || typeof value.automatic !== "boolean" || !Number.isInteger(value.intervalMinutes) || value.intervalMinutes < 5 || value.intervalMinutes > 1440 || !Number.isInteger(value.retention) || value.retention < 10 || value.retention > 2000 || !Array.isArray(value.feeds) || value.feeds.length > 500 || !Array.isArray(value.rules) || value.rules.length > 100 || !Array.isArray(value.briefs) || value.briefs.length > 50) throw new RssError("Invalid RSS settings");
  for (const feed of value.feeds) {
    if (!feed || typeof feed !== "object") throw new RssError("Invalid subscription");
    identifier(feed.id);
    if (!string(feed.name, 200) || !feed.name.trim() || !string(feed.folder, 500) || typeof feed.enabled !== "boolean" || !string(feed.addedAt, 50) || !string(feed.url, 4000)) throw new RssError("Invalid subscription");
    if (feedUrl(feed.url) !== feed.url) throw new RssError("Invalid subscription URL");
  }
  for (const entries of [value.feeds, value.rules, value.briefs]) if (new Set(entries.map((item) => item.id)).size !== entries.length) throw new RssError("Duplicate RSS identifiers");
  if (new Set(value.feeds.map((feed) => feed.url)).size !== value.feeds.length) throw new RssError("This feed is already subscribed in this room", 409);
  value.rules.forEach(validateRule); value.briefs.forEach(validateBrief);
  for (const selection of [...value.rules, ...value.briefs]) if (selection.feedIds.some((id) => !value.feeds.some((feed) => feed.id === id))) throw new RssError("Selected feed does not belong to this room");
}
export class RssStore {
  private locks = new Map<string, Promise<unknown>>();
  constructor(public root = DATA_DIR, public rooms: () => Promise<{ path: string }[]> = listRooms, private writable: (virtualPath: string) => Promise<void> = assertWritablePath) {}
  async locked<T>(room: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(room) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.locks.set(room, next);
    try { return await next; } finally { if (this.locks.get(room) === next) this.locks.delete(room); }
  }
  async file(room: string, relative: string, write = false): Promise<string> {
    if (!(await this.rooms()).some((entry) => entry.path === room)) throw new RssError("Room not found", 404);
    if (room !== "." && (room.includes("/") || room.includes("\\") || room === "..")) throw new RssError("Invalid room");
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => !part || part === "." || part === "..")) throw new RssError("Invalid RSS path");
    if (this.root === DATA_DIR) resolveContentPath(room === "." ? relative : `${room}/${relative}`);
    const base = path.resolve(this.root);
    const parts = [...(room === "." ? [] : [room]), ...relative.split("/")];
    let target = base;
    for (const part of parts) {
      target = path.join(target, part);
      try { if ((await fs.lstat(target)).isSymbolicLink()) throw new RssError("RSS paths cannot follow symbolic links", 403); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (write) await this.writable(room === "." ? relative : `${room}/${relative}`);
    return target;
  }
  async read<T>(room: string, relative: string, fallback: T): Promise<T> {
    const file = await this.file(room, relative);
    try {
      const stat = await fs.stat(file);
      if (stat.size > 80 * 1024 * 1024) throw new RssError("RSS state exceeds its size limit", 409);
      return JSON.parse(await fs.readFile(file, "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
      if (error instanceof SyntaxError) throw new RssError("RSS state is corrupt. Restore the file from a backup", 409);
      throw error;
    }
  }
  async write(room: string, relative: string, value: unknown): Promise<void> {
    const file = await this.file(room, relative, true);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await this.file(room, relative, true);
    await writeFileAtomic(file, JSON.stringify(value, null, 2));
  }
  async config(room: string): Promise<RssConfig> {
    const config = await this.read(room, ".agents/.config/rss.json", emptyConfig());
    validateConfig(config);
    return config;
  }
  async save(room: string, config: RssConfig): Promise<void> { validateConfig(config); await this.write(room, ".agents/.config/rss.json", config); }
  async cache(room: string, id: string): Promise<RssCache> {
    const cache = await this.read(room, `.agents/.runtime/rss/${identifier(id)}.json`, emptyCache());
    if (!cache || cache.version !== 1 || !Array.isArray(cache.articles) || !strings(cache.seen, 10000) || !strings(cache.deleted ?? [], 1000000) || cache.articles.length > 2000 || cache.articles.some((a) => !a || a.feedId !== id || !string(a.id, 100) || !string(a.title, 1000) || !string(a.text, 128000) || !string(a.html, 512000) || !strings(a.authors) || !strings(a.categories) || typeof a.read !== "boolean" || !string(a.firstSeenAt, 50) || !Number.isFinite(Date.parse(a.firstSeenAt)) || (a.publishedAt !== null && (!string(a.publishedAt, 50) || !Number.isFinite(Date.parse(a.publishedAt)))) || (a.language !== null && !string(a.language, 100)) || (a.url !== null && (!string(a.url, 4000) || !/^https?:\/\//.test(a.url))))) throw new RssError("Invalid RSS article cache", 409);
    return cache;
  }
  async saveCache(room: string, id: string, cache: RssCache): Promise<void> { await this.write(room, `.agents/.runtime/rss/${identifier(id)}.json`, cache); }
  async runs(room: string): Promise<RssBriefRun[]> {
    const runs = await this.read<RssBriefRun[]>(room, ".agents/.runtime/rss/brief-runs.json", []);
    if (!Array.isArray(runs) || runs.some((run) => !run || !Array.isArray(run.articles) || !string(run.id, 100))) throw new RssError("Invalid brief run state", 409);
    return runs;
  }
  async saveRuns(room: string, runs: RssBriefRun[]): Promise<void> {
    const unfinished = new Set(["preparing", "running", "uncertain", "publish-pending"]);
    const pending = runs.filter((run) => unfinished.has(run.status));
    const terminal = runs.filter((run) => !unfinished.has(run.status));
    const recent = terminal.filter((run) => Date.parse(run.createdAt) >= Date.now() - 86400000 || run.status === "failed").slice(-200);
    const ids = new Set(recent.map((run) => run.id));
    await this.write(room, ".agents/.runtime/rss/brief-runs.json", [...pending, ...terminal.filter((run) => !ids.has(run.id)).slice(-100), ...recent].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  }
  async publish(room: string, relative: string, content: string): Promise<void> {
    const file = await this.file(room, relative, true);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await this.file(room, relative, true);
    const temp = `${file}.tmp-${randomUUID()}`;
    try { await fs.writeFile(temp, content, { flag: "wx" }); await fs.link(temp, file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new RssError("The brief page already exists. It has not been overwritten", 409); throw error; }
    finally { await fs.unlink(temp).catch(() => {}); }
  }
}
