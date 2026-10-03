import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RssStore } from "../server/rss/store";
import { RssService } from "../server/rss/service";
import { RssBriefs, briefJobId } from "../server/rss/briefs";
import { emptyConfig, type RssArticle, type RssBrief, type RssFeed } from "../src/lib/rss/types";
import { normalizeJobConfig } from "../src/lib/jobs/job-normalization";
import type { ConversationMeta } from "../src/types/conversations";

const now = Date.parse("2026-10-03T12:00:00Z");
const feed: RssFeed = { id: "feed", name: "News", folder: "Tech", url: "https://example.com/feed", enabled: true, addedAt: new Date(now).toISOString() };
const article: RssArticle = { id: "one", feedId: "feed", title: "Article", html: "<p>Content</p>", text: "Content", url: "https://example.com/article", authors: [], categories: [], language: null, publishedAt: null, firstSeenAt: new Date(now).toISOString(), read: false };
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-rss-service-"));
  const store = new RssStore(root, async () => [{ path: "room" }], async () => {});
  await store.save("room", { ...emptyConfig(), feeds: [feed] });
  return { root, store, close: () => fs.rm(root, { recursive: true, force: true }) };
}
test("refresh coalesces, preserves concurrent reading state and filters apply after 304", async () => {
  const f = await fixture();
  let release!: () => void; let calls = 0;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const service = new RssService(f.store, async () => { calls++; await wait; return { articles: [article], etag: "tag", lastModified: undefined }; }, () => now);
  try {
    await f.store.saveCache("room", feed.id, { version: 1, articles: [article], seen: [article.id], error: null, checkedAt: null });
    service.queue("room", feed); service.queue("room", feed);
    await service.act("room", { action: "read", id: article.id, read: true });
    release(); await service.idle();
    assert.equal(calls, 1); assert.equal((await f.store.cache("room", feed.id)).articles[0].read, true);
    const config = await f.store.config("room");
    await service.act("room", { action: "rule-save", revision: config.revision, rule: { id: "r", name: "Hidden", enabled: true, feedIds: [], folders: [], mode: "all", conditions: [{ field: "title", operator: "contains", value: "Article" }] } });
    assert.equal((await service.articles("room")).total, 0);
    assert.equal((await service.articles("room", { excluded: true })).total, 1);
    await service.act("room", { action: "rule-remove", id: "r" });
    assert.equal((await service.articles("room")).total, 1);
  } finally { release(); await service.close(); await f.close(); }
});
test("automatic refresh is opt-in and concurrent fetches remain bounded", async () => {
  const f = await fixture();
  const feeds = Array.from({ length: 8 }, (_, index) => ({ ...feed, id: `feed${index}`, url: `https://example.com/feed${index}` }));
  await f.store.save("room", { ...emptyConfig(), feeds });
  let active = 0, maximum = 0, calls = 0, release!: () => void, reachedFour!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const four = new Promise<void>((resolve) => { reachedFour = resolve; });
  const service = new RssService(f.store, async () => { calls++; active++; maximum = Math.max(maximum, active); if (calls === 4) reachedFour(); await gate; active--; return { articles: [], etag: undefined, lastModified: undefined }; }, () => now);
  try {
    await service.tick(); assert.equal(calls, 0);
    await service.act("room", { action: "settings", automatic: true, intervalMinutes: 30, retention: 500 });
    await service.tick(); await four;
    assert.equal(maximum, 4); service.queue("room", feeds[0]);
    release(); await service.idle(); assert.equal(calls, 8); assert.equal(maximum, 4);
    await service.tick(); assert.equal(calls, 8);
  } finally { release(); await service.close(); await f.close(); }
});

test("stale settings do not erase subscriptions or broaden removed-feed selections", async () => {
  const f = await fixture();
  const service = new RssService(f.store);
  try {
    await assert.rejects(service.act("room", { action: "settings", revision: 99, automatic: true, intervalMinutes: 30, retention: 500 }), /Settings changed/);
    await service.act("room", { action: "rule-save", rule: { id: "selected", name: "Only this feed", enabled: true, feedIds: [feed.id], folders: [], mode: "all", conditions: [{ field: "title", operator: "contains", value: "Article" }] } });
    await service.act("room", { action: "feed-remove", id: feed.id });
    const rule = (await f.store.config("room")).rules[0];
    assert.equal(rule.enabled, false); assert.equal(rule.needsSelection, true);
    await assert.rejects(service.act("room", { action: "rule-save", rule: { ...rule, enabled: true } }), /Select sources/);
  } finally { await service.close(); await f.close(); }
});

test("a removed feed cannot be resurrected by a late response", async () => {
  const f = await fixture(); let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const service = new RssService(f.store, async () => { await gate; return { articles: [article], etag: undefined, lastModified: undefined }; });
  try { service.queue("room", feed); await service.act("room", { action: "feed-remove", id: feed.id }); release(); await service.idle(); assert.equal((await f.store.config("room")).feeds.length, 0); assert.equal((await f.store.cache("room", feed.id)).articles.length, 0); }
  finally { release(); await service.close(); await f.close(); }
});
test("brief retries reuse input and restart recovery publishes a correlated completed conversation", async () => {
  const f = await fixture();
  let clock = now;
  const service = new RssService(f.store, undefined, () => clock);
  const brief: RssBrief = { id: "retry", name: "Retry brief", agentSlug: "writer", feedIds: [], folders: [], instructions: "Summarize", schedule: "0 9 * * *", enabled: false, outputFolder: "Briefs", maxArticles: 10, maxBytes: 10000 };
  const config = await f.store.config("room"); config.briefs = [brief]; await f.store.save("room", config);
  await f.store.saveCache("room", feed.id, { version: 1, articles: [article], seen: [], checkedAt: null, error: null });
  let metas: ConversationMeta[] = [];
  const briefs = new RssBriefs(service, { job: async () => normalizeJobConfig({ id: briefJobId(brief.id), rssBriefId: brief.id }, "writer"), disableJob: async () => {}, execute: async () => ({ id: "run", jobId: "job", status: "running", startedAt: "", output: "" }), conversations: async () => metas, output: async () => "# Recovered brief", checkStorage: async () => {}, published: async () => {} }, () => clock);
  try {
    const first = await briefs.prepare("room", brief.id, briefJobId(brief.id), "writer");
    await briefs.complete("room", first.runId, "failed", "Failed");
    clock++;
    const retry = await briefs.prepare("room", brief.id, briefJobId(brief.id), "writer", undefined, first.runId);
    assert.notEqual(retry.runId, first.runId); assert.equal(retry.prompt, first.prompt);
    clock += 121000; await briefs.recover("room");
    assert.equal((await f.store.runs("room")).find((run) => run.id === retry.runId)?.status, "uncertain");
    metas = [{ id: "conversation", rssBriefRunId: retry.runId, agentSlug: "writer", cabinetPath: "room", title: "Brief", trigger: "job", status: "completed", startedAt: new Date(now).toISOString(), promptPath: "", transcriptPath: "", mentionedPaths: [], artifactPaths: [] }];
    await briefs.recover("room");
    assert.equal((await f.store.runs("room")).find((run) => run.id === retry.runId)?.status, "completed");
    await assert.rejects(briefs.prepare("room", brief.id, briefJobId(brief.id), "writer", undefined, first.runId), /already been processed/);
  } finally { await service.close(); await f.close(); }
});

test("briefs claim input once, do not consume read state, publish dated pages and recover publication failure", async () => {
  const f = await fixture();
  const service = new RssService(f.store, undefined, () => now);
  const brief: RssBrief = { id: "brief", name: "Daily news", agentSlug: "writer", feedIds: [], folders: [], instructions: "Summarize", schedule: "0 9 * * *", enabled: false, outputFolder: "RSS Briefs/Daily", maxArticles: 10, maxBytes: 10000 };
  const config = await f.store.config("room"); config.briefs = [brief]; await f.store.save("room", config);
  await f.store.saveCache("room", feed.id, { version: 1, articles: [{ ...article, read: true }], seen: [], checkedAt: null, error: null });
  let storageBlocked = true;
  const briefs = new RssBriefs(service, { job: async () => normalizeJobConfig({ id: briefJobId(brief.id), rssBriefId: brief.id }, "writer"), disableJob: async () => {}, execute: async () => ({ id: "run", jobId: "job", status: "running", startedAt: "" , output: "" }), conversations: async () => [], output: async () => "", checkStorage: async () => { if (storageBlocked) throw new Error("Full"); }, published: async () => {} }, () => now);
  try {
    const prepared = await briefs.prepare("room", brief.id, briefJobId(brief.id), "writer");
    assert.equal(prepared.skip, false); assert.match(prepared.prompt, /UNTRUSTED/);
    assert.equal((await briefs.prepare("room", brief.id, briefJobId(brief.id), "writer")).skip, true);
    await briefs.complete("room", prepared.runId, "completed", "# Daily brief\n\nA development.");
    assert.equal((await f.store.runs("room"))[0].status, "publish-pending");
    storageBlocked = false; await briefs.recover("room");
    const run = (await f.store.runs("room"))[0]; assert.equal(run.status, "completed");
    assert.match(await fs.readFile(path.join(f.root, run.pagePath!), "utf8"), /https:\/\/example.com\/article/);
    assert.equal((await f.store.cache("room", feed.id)).articles[0].read, true);
    assert.equal((await briefs.prepare("room", brief.id, briefJobId(brief.id), "writer")).skip, true);
    assert.equal(normalizeJobConfig({ rssBriefId: "brief" }).rssBriefId, "brief");
  } finally { await service.close(); await f.close(); }
});
