import { randomUUID } from "node:crypto";
import { RssStore, RssError, identifier, validateRule, validateConfig } from "./store";
import { fetchRss, RssFetchError } from "../../src/lib/rss/fetch";
import { importOpml, exportOpml, feedUrl } from "../../src/lib/rss/opml";
import { matchingRules } from "../../src/lib/rss/filters";
import type { RssArticle, RssRule, RssCache, RssFeed, RssState } from "../../src/lib/rss/types";
import type { RssBriefs } from "./briefs";
import { computeNextCronRun } from "../../src/lib/agents/cron-compute";

export class RssService {
  briefs?: RssBriefs;
  private controller = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private pending = new Map<string, Promise<void>>();
  private tasks: (() => void)[] = [];
  private active = 0;
  private ticking = false;
  constructor(public store = new RssStore(), private transport = fetchRss, private now = () => Date.now(), private stale = () => false) {}
  async state(room: string): Promise<RssState> {
    const config = await this.store.config(room);
    const feeds: RssState["feeds"] = [];
    for (const feed of config.feeds) {
      const cache = await this.store.cache(room, feed.id);
      const included = cache.articles.filter((article) => !matchingRules(article, config.rules, feed.folder, this.now()).length);
      feeds.push({ ...feed, unread: included.filter((a) => !a.read).length, excluded: cache.articles.length - included.length, checkedAt: cache.checkedAt, error: cache.error, refreshing: this.pending.has(`${room}:${feed.id}:${feed.url}`) });
    }
    const runs = (await this.store.runs(room)).map(({ id, briefId, createdAt, status, conversationId, pagePath, error, omitted }) => ({ id, briefId, createdAt, status, conversationId, pagePath, error, omitted }));
    return { room, config, feeds, runs, nextRuns: Object.fromEntries(config.briefs.map((brief) => [brief.id, brief.enabled ? computeNextCronRun(brief.schedule, new Date(this.now()))?.toISOString() || null : null])), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  }
  async articles(room: string, options: { feedId?: string; unread?: boolean; excluded?: boolean; offset?: number; limit?: number; id?: string } = {}) {
    const config = await this.store.config(room);
    if (options.feedId && !config.feeds.some((feed) => feed.id === options.feedId)) throw new RssError("Feed not found in this room", 404);
    const all: (RssArticle & { excludedBy: string[]; feedName: string })[] = [];
    for (const feed of config.feeds.filter((f) => !options.feedId || f.id === options.feedId)) {
      const cache = await this.store.cache(room, feed.id);
      for (const article of cache.articles) {
        const excludedBy = matchingRules(article, config.rules, feed.folder, this.now());
        if ((!options.id || article.id === options.id) && (!options.unread || !article.read) && (options.excluded || !excludedBy.length)) all.push({ ...article, html: options.id ? article.html : "", text: options.id ? article.text : article.text.slice(0, 300), excludedBy, feedName: feed.name });
      }
    }
    all.sort((a, b) => (b.publishedAt || b.firstSeenAt).localeCompare(a.publishedAt || a.firstSeenAt) || a.id.localeCompare(b.id));
    if (options.id && !all.length) throw new RssError("Article not found in this room", 404);
    const offset = Number.isFinite(options.offset) ? Math.max(0, Math.floor(options.offset!)) : 0;
    const limit = Number.isFinite(options.limit) && options.limit! > 0 ? Math.min(100, Math.floor(options.limit!)) : 50;
    return { total: all.length, articles: all.slice(offset, offset + limit).map((a) => options.id ? a : { ...a, html: "", text: a.text.slice(0, 300) }) };
  }
  async act(room: string, input: Record<string, unknown>): Promise<unknown> {
    if (this.stale()) throw new RssError("Cabinet has switched. Restart the background service", 503);
    const action = input.action;
    if (input.feedId && !(await this.store.config(room)).feeds.some((feed) => feed.id === input.feedId)) throw new RssError("Feed not found in this room", 404);
    if (action === "brief-save" || action === "brief-remove" || action === "brief-run" || action === "brief-retry") {
      if (!this.briefs) throw new RssError("AI briefs are unavailable", 503);
      return this.briefs.act(room, input);
    }
    if (action === "refresh") {
      const config = await this.store.config(room);
      const feeds = config.feeds.filter((f) => f.enabled && (!input.feedId || f.id === input.feedId));
      for (const feed of feeds) this.queue(room, feed);
      return this.state(room);
    }
    if (action === "opml-preview") {
      try { return importOpml(String(input.content || ""), (await this.store.config(room)).feeds); }
      catch (error) { if (error instanceof RssError) throw error; throw new RssError(error instanceof Error ? error.message : "Invalid OPML file"); }
    }
    if (action === "rule-preview") {
      const rule = input.rule as RssRule; validateRule(rule);
      const config = await this.store.config(room);
      const matches: { title: string; feedName: string }[] = [];
      for (const feed of config.feeds) for (const article of (await this.store.cache(room, feed.id)).articles) if (matchingRules(article, [rule], feed.folder, this.now()).length) matches.push({ title: article.title, feedName: feed.name });
      return { count: matches.length, matches: matches.slice(0, 20) };
    }
    let added: RssFeed[] = [];
    let report: unknown;
    await this.store.locked(room, async () => {
      const config = await this.store.config(room);
      if (typeof input.revision === "number" && input.revision !== config.revision) throw new RssError("Settings changed in another window. Refresh and try again", 409);
      if (action === "settings") {
        if (typeof input.automatic !== "boolean" || typeof input.intervalMinutes !== "number" || typeof input.retention !== "number") throw new RssError("Invalid RSS settings");
        config.automatic = input.automatic; config.intervalMinutes = input.intervalMinutes; config.retention = input.retention;
      } else if (action === "feed-save") {
        if (typeof input.url !== "string" || typeof input.name !== "string" || typeof input.folder !== "string" || typeof input.enabled !== "boolean") throw new RssError("Invalid feed");
        const id = input.id ? identifier(input.id) : randomUUID();
        const existing = config.feeds.find((f) => f.id === id);
        if (input.id && !existing) throw new RssError("Feed not found", 404);
        let url: string;
        try { url = feedUrl(input.url); } catch { throw new RssError("Use a public HTTP or HTTPS feed URL without credentials"); }
        const feed = { id, url, name: input.name.trim() || new URL(input.url).hostname, folder: input.folder.trim(), enabled: input.enabled, addedAt: existing?.addedAt || new Date(this.now()).toISOString() };
        config.feeds = [...config.feeds.filter((f) => f.id !== id), feed];
        validateConfig(config);
        if (!existing || existing.url !== feed.url) { await this.store.saveCache(room, id, { version: 1, articles: [], seen: [], checkedAt: null, error: null }); added = [feed]; }
      } else if (action === "feed-remove") {
        const id = identifier(input.id);
        config.feeds = config.feeds.filter((f) => f.id !== id);
        for (const rule of config.rules) if (rule.feedIds.includes(id)) { rule.feedIds = rule.feedIds.filter((f) => f !== id); if (!rule.feedIds.length && !rule.folders.length) { rule.enabled = false; rule.needsSelection = true; } }
        for (const brief of config.briefs) if (brief.feedIds.includes(id)) { brief.feedIds = brief.feedIds.filter((f) => f !== id); if (!brief.feedIds.length && !brief.folders.length) { brief.enabled = false; brief.needsSelection = true; } }
      } else if (action === "opml-import") {
        let result: ReturnType<typeof importOpml>;
        try { result = importOpml(String(input.content || ""), config.feeds); }
        catch (error) { throw new RssError(error instanceof Error ? error.message : "Invalid OPML file"); }
        added = result.added; config.feeds.push(...added); report = { imported: added.length, duplicates: result.duplicates, invalid: result.invalid };
      } else if (action === "rule-save") {
        const rule = input.rule as RssRule; validateRule(rule);
        config.rules = [...config.rules.filter((r) => r.id !== rule.id), rule];
      } else if (action === "rule-remove") config.rules = config.rules.filter((r) => r.id !== identifier(input.id));
      else if (action === "read") {
        if (typeof input.read !== "boolean") throw new RssError("Invalid reading state");
        if (input.id && !(await this.articles(room, { id: String(input.id), excluded: true })).total) throw new RssError("Article not found in this room", 404);
        for (const feed of config.feeds.filter((f) => !input.feedId || f.id === input.feedId)) {
          const cache = await this.store.cache(room, feed.id);
          for (const article of cache.articles) if ((input.id ? article.id === input.id : !matchingRules(article, config.rules, feed.folder, this.now()).length)) article.read = input.read;
          await this.store.saveCache(room, feed.id, cache);
        }
        return;
      } else throw new RssError("Unknown RSS action");
      config.revision++; await this.store.save(room, config);
    });
    if (action === "feed-remove") {
      await this.store.locked(room, () => this.store.saveCache(room, identifier(input.id), { version: 1, articles: [], seen: [], checkedAt: null, error: null }));
      await this.briefs?.syncSelections(room);
    }
    for (const feed of added.filter((f) => f.enabled)) this.queue(room, feed);
    return { ...await this.state(room), report };
  }
  async opml(room: string) { return exportOpml((await this.store.config(room)).feeds); }
  queue(room: string, feed: RssFeed): void {
    const key = `${room}:${feed.id}:${feed.url}`;
    if (this.pending.has(key) || this.controller.signal.aborted || this.stale()) return;
    const task = new Promise<void>((resolve) => {
      this.tasks.push(() => { this.active++; void this.refresh(room, feed).catch(() => {}).finally(() => { this.active--; resolve(); this.drain(); }); });
    });
    this.pending.set(key, task);
    void task.finally(() => this.pending.delete(key));
    this.drain();
  }
  private drain() { while (this.active < 4 && this.tasks.length) this.tasks.shift()!(); }
  private async refresh(room: string, feed: RssFeed) {
    const previous = await this.store.cache(room, feed.id);
    let result: Awaited<ReturnType<typeof fetchRss>> | undefined;
    let retryAfterMs = 0;
    try { result = await this.transport(feed, previous, this.controller.signal); }
    catch (error) { if (this.controller.signal.aborted) return; if (error instanceof RssFetchError) retryAfterMs = error.retryAfterMs; }
    await this.store.locked(room, async () => {
      const config = await this.store.config(room);
      if (this.stale() || !config.feeds.some((f) => f.id === feed.id && f.url === feed.url && f.enabled)) return;
      const cache: RssCache = await this.store.cache(room, feed.id);
      cache.checkedAt = new Date(this.now()).toISOString();
      cache.error = result ? null : "Feed refresh failed. Check the URL or try again later";
      cache.failures = result ? 0 : (cache.failures || 0) + 1;
      cache.nextAttemptAt = new Date(this.now() + (result ? config.intervalMinutes * 60000 : Math.max(retryAfterMs, Math.min(86400000, 60000 * 2 ** Math.min(cache.failures, 10))))).toISOString();
      if (result) {
        if (result.articles) {
          const articles = new Map(cache.articles.map((a) => [a.id, a]));
          const seen = new Set(cache.seen);
          for (const article of result.articles) { const old = articles.get(article.id); articles.set(article.id, { ...article, firstSeenAt: old?.firstSeenAt || article.firstSeenAt, read: old?.read ?? seen.has(article.id) }); seen.add(article.id); }
          let totalBytes = 0;
          cache.articles = [...articles.values()].sort((a, b) => (b.publishedAt || b.firstSeenAt).localeCompare(a.publishedAt || a.firstSeenAt)).slice(0, config.retention).filter((article) => { totalBytes += Buffer.byteLength(JSON.stringify(article)); return totalBytes <= 20 * 1024 * 1024; });
          cache.seen = [...seen].slice(-10000);
        }
        cache.etag = result.etag; cache.lastModified = result.lastModified;
      }
      await this.store.saveCache(room, feed.id, cache);
    });
  }
  async idle() { await Promise.all([...this.pending.values()]); }
  async tick() {
    if (this.ticking || this.controller.signal.aborted || this.stale()) return;
    this.ticking = true;
    try {
      for (const room of await this.store.rooms()) {
        try {
          const config = await this.store.config(room.path);
          if (config.automatic) for (const feed of config.feeds.filter((f) => f.enabled)) { const cache = await this.store.cache(room.path, feed.id); if (!cache.nextAttemptAt || Date.parse(cache.nextAttemptAt) <= this.now()) this.queue(room.path, feed); }
          await this.briefs?.recover(room.path);
        } catch { }
      }
    } finally { this.ticking = false; }
  }
  start() { void this.tick(); this.timer = setInterval(() => void this.tick(), 60000); }
  async close() { clearInterval(this.timer); this.controller.abort(); this.drain(); await this.idle(); }
}
