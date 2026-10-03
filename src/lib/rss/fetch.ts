import { safeFetch } from "../net/ssrf-guard";
import { normalizeFeed } from "./parse";
import { feedUrl } from "./opml";
import type { RssArticle, RssCache, RssFeed } from "./types";

export interface RssFetchResult { articles: RssArticle[] | null; etag?: string; lastModified?: string; retryAfterMs?: number }
export class RssFetchError extends Error {
  constructor(message: string, public retryAfterMs = 0) { super(message); }
}
export async function fetchRss(feed: RssFeed, cache: RssCache, signal: AbortSignal, transport = safeFetch): Promise<RssFetchResult> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
  const response = await transport(feedUrl(feed.url), { signal: deadline, timeoutMs: 10000, headers: { "User-Agent": "Cabinet RSS reader", "Accept-Encoding": "identity", ...(cache.etag ? { "If-None-Match": cache.etag } : {}), ...(cache.lastModified ? { "If-Modified-Since": cache.lastModified } : {}) } });
  try {
    if (response.status === 304) return { articles: null, etag: cache.etag, lastModified: cache.lastModified };
    if (response.status !== 200) {
      const raw = response.headers["retry-after"];
      const retry = typeof raw === "string" ? (/^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now()) : 0;
      throw new RssFetchError(`Feed returned HTTP ${response.status}`, Number.isFinite(retry) ? Math.max(0, Math.min(86400000, retry)) : 0);
    }
    if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") throw new Error("Feed returned unsupported compressed content");
    const max = 5 * 1024 * 1024;
    const content = await response.readText(max + 1);
    if (Buffer.byteLength(content) > max) throw new Error("Feed exceeds the 5 MB limit");
    return { articles: normalizeFeed(content, response.finalUrl, feed.id).articles, etag: typeof response.headers.etag === "string" ? response.headers.etag : undefined, lastModified: typeof response.headers["last-modified"] === "string" ? response.headers["last-modified"] : undefined };
  } finally { response.dispose(); }
}
