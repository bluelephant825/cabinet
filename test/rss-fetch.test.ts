import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { fetchRss, RssFetchError } from "../src/lib/rss/fetch";
import { emptyCache, type RssFeed } from "../src/lib/rss/types";
import { safeFetch, assertPublicHttpUrl, type SafeFetchOptions, type SafeFetchResult } from "../src/lib/net/ssrf-guard";

const feed: RssFeed = { id: "f", name: "Feed", folder: "", url: "https://example.com/feed", enabled: true, addedAt: new Date().toISOString() };
const response = (overrides: Partial<SafeFetchResult> = {}): SafeFetchResult => ({ status: 200, headers: {}, finalUrl: feed.url, readText: async () => "", dispose: () => {}, ...overrides });
test("RSS conditional 304 disposes its response, passes validators and preserves cache", async () => {
  let disposed = false;
  const result = await fetchRss(feed, { ...emptyCache(), etag: "tag", lastModified: "date" }, new AbortController().signal, async (_url, options) => {
    assert.equal(options?.headers?.["If-None-Match"], "tag");
    assert.equal(options?.headers?.["If-Modified-Since"], "date");
    assert.equal(options?.headers?.["Accept-Encoding"], "identity");
    assert.ok(options?.signal);
    return response({ status: 304, dispose: () => { disposed = true; }, readText: async () => { throw new Error("Should not read a 304"); } });
  });
  assert.equal(result.articles, null); assert.equal(result.etag, "tag"); assert.equal(disposed, true);
});
test("RSS rejects overflow/compression, honors Retry-After and rejects private URLs before transport", async () => {
  const signal = new AbortController().signal;
  await assert.rejects(fetchRss(feed, emptyCache(), signal, async () => response({ readText: async () => "x".repeat(5 * 1024 * 1024 + 1) })), /exceeds/);
  await assert.rejects(fetchRss(feed, emptyCache(), signal, async () => response({ headers: { "content-encoding": "gzip" } })), /compressed/);
  await assert.rejects(fetchRss(feed, emptyCache(), signal, async () => response({ status: 429, headers: { "retry-after": "300" } })), (error) => error instanceof RssFetchError && error.retryAfterMs === 300000);
  await assert.rejects(fetchRss({ ...feed, url: "http://127.0.0.1/feed" }, emptyCache(), signal, async () => { throw new Error("Transport must not execute"); }), /private-address/);
  for (const url of ["http://169.254.169.254/", "http://[::1]/", "file:///tmp/feed", "http://localhost/"]) assert.throws(() => assertPublicHttpUrl(url));
});
test("safeFetch forwards cancellation and strips sensitive headers on cross-origin redirects", async (context) => {
  const requests: { url: URL; options: SafeFetchOptions }[] = [];
  context.mock.method(http, "request", (url: URL, options: SafeFetchOptions, callback: (res: http.IncomingMessage) => void) => {
    requests.push({ url, options });
    const request = new EventEmitter() as EventEmitter & { setTimeout: () => void; end: () => void; destroy: () => void };
    request.setTimeout = () => {}; request.destroy = () => {};
    request.end = () => {
      const stream = new PassThrough() as unknown as PassThrough & http.IncomingMessage;
      stream.statusCode = requests.length === 1 ? 302 : 200;
      stream.headers = requests.length === 1 ? { location: "http://other.example/feed" } : {};
      queueMicrotask(() => { callback(stream); stream.end(); });
    };
    return request;
  });
  const controller = new AbortController();
  const result = await safeFetch("http://example.com/feed", { signal: controller.signal, headers: { Authorization: "not-a-real-secret", Cookie: "fixture", "If-None-Match": "tag", Accept: "application/xml" } });
  result.dispose();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.signal, controller.signal);
  assert.deepEqual(requests[1].options.headers, { Accept: "application/xml" });
});
