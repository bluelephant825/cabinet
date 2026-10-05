import test from "node:test";
import assert from "node:assert/strict";
import { normalizeFeed } from "../src/lib/rss/parse";
import { matchingRules } from "../src/lib/rss/filters";
import { cleanBriefMarkdown } from "../src/lib/rss/brief-output";
import { importOpml, exportOpml } from "../src/lib/rss/opml";
import type { RssArticle, RssRule } from "../src/lib/rss/types";

const article: RssArticle = { id: "a", feedId: "f", title: "Technology news", text: "Useful news", html: "", authors: ["Alice", "Bob"], categories: ["Tech"], url: "https://example.com/a", publishedAt: null, firstSeenAt: "2026-10-03T08:00:00Z", read: false, language: null };
const rule: RssRule = { id: "r", name: "Noise", enabled: true, feedIds: [], folders: [], mode: "all", conditions: [{ field: "title", operator: "contains", value: "NEWS" }] };
test("RSS rules are reversible and have explicit missing/array semantics", () => {
  assert.deepEqual(matchingRules(article, [rule], ""), ["Noise"]);
  assert.equal(article.read, false);
  assert.deepEqual(matchingRules(article, [{ ...rule, enabled: false }], ""), []);
  assert.deepEqual(matchingRules(article, [{ ...rule, conditions: [{ field: "language", operator: "not-equals", value: "en" }] }], ""), []);
  assert.deepEqual(matchingRules(article, [{ ...rule, conditions: [{ field: "language", operator: "is-missing", value: "" }] }], ""), ["Noise"]);
  assert.deepEqual(matchingRules(article, [{ ...rule, conditions: [{ field: "author", operator: "not-equals", value: "Alice" }] }], ""), []);
  assert.deepEqual(matchingRules(article, [{ ...rule, feedIds: ["other"] }], ""), []);
});
test("RSS Contains matches literal case-insensitive fragments, not wildcard patterns", () => {
  const gamesRule: RssRule = { ...rule, name: "Games", conditions: [{ field: "title", operator: "contains", value: "gam" }] };
  for (const title of ["New GAME release", "Video games news", "Gaming hardware"]) {
    assert.deepEqual(matchingRules({ ...article, title }, [gamesRule], ""), ["Games"]);
    assert.deepEqual(matchingRules({ ...article, title }, [{ ...gamesRule, conditions: [{ field: "title", operator: "contains", value: "gam*" }] }], ""), []);
  }
  assert.deepEqual(matchingRules({ ...article, title: "A literal gam* query" }, [{ ...gamesRule, conditions: [{ field: "title", operator: "contains", value: "gam*" }] }], ""), ["Games"]);
  const cityGames = { ...article, title: "City building games have a Soul Problem pt.2" };
  for (const value of ["gam", " gam"]) assert.deepEqual(matchingRules(cityGames, [{ ...gamesRule, conditions: [{ field: "title", operator: "contains", value }] }], ""), ["Games"]);
  const bodyOnly = { ...article, title: "New controller review", text: "Gaming hardware" };
  assert.deepEqual(matchingRules(bodyOnly, [gamesRule], ""), []);
  assert.deepEqual(matchingRules(bodyOnly, [{ ...gamesRule, conditions: [{ field: "body", operator: "contains", value: "gam" }] }], ""), ["Games"]);
});
test("FeedSmith normalizes formats and preserves stable identities", () => {
  const rss = '<rss version="2.0"><channel><title>Test</title><link>https://example.com</link><description>Test</description><language>en</language><item><guid>one</guid><title>News</title><link>/article</link><category>Tech</category><description>&lt;p&gt;Text&lt;/p&gt;</description></item></channel></rss>';
  const result = normalizeFeed(rss, "https://example.com/rss", "f");
  assert.equal(result.articles[0].url, "https://example.com/article");
  assert.equal(result.articles[0].language, "en");
  assert.equal(result.articles[0].text, "Text");
  assert.deepEqual(result.articles[0].categories, ["Tech"]);
  assert.equal(result.articles[0].id, normalizeFeed(rss, "https://example.com/rss", "f").articles[0].id);
  const atom = '<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>feed</id><entry><id>one</id><title>Entry</title><link href="https://example.com/entry"/><updated>2026-10-03T08:00:00Z</updated></entry></feed>';
  assert.equal(normalizeFeed(atom, "https://example.com/feed", "f").articles[0].title, "Entry");
  assert.equal(normalizeFeed(JSON.stringify({ version: "https://jsonfeed.org/version/1.1", title: "JSON", items: [{ id: "one", content_text: "Text" }] }), "https://example.com/feed", "f").articles[0].text, "Text");
  const rdf = '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"><channel rdf:about="https://example.com/feed"><title>RDF</title><link>https://example.com</link><description>RDF feed</description></channel><item rdf:about="https://example.com/story"><title>RDF story</title><link>https://example.com/story</link><description>RDF content</description></item></rdf:RDF>';
  assert.equal(normalizeFeed(rdf, "https://example.com/feed", "f").articles[0].title, "RDF story");
  assert.throws(() => normalizeFeed('<!DOCTYPE rss [<!ENTITY x "test">]><rss/>', "https://example.com/feed", "f"));
});
test("brief output drops executable HTML, media and non-source links", () => {
  const output = cleanBriefMarkdown('# Brief\n\n[Source](https://example.com/article) [Bad](file:///tmp/test) ![pixel](https://tracker.example/pixel)\n\n<script>alert(1)</script>', ["https://example.com/article"]);
  assert.match(output, /\[Source\]\(https:\/\/example.com\/article\)/);
  assert.doesNotMatch(output, /file:|tracker|script/);
});

test("OPML roundtrips nested folders, escaped labels and reports duplicate/invalid URLs", () => {
  const xml = '<opml version="2.0"><body><outline text="Tech"><outline text="News &amp; tools" xmlUrl="https://example.com/feed"/><outline xmlUrl="https://example.com/feed"/><outline xmlUrl="file:///bad"/></outline></body></opml>';
  const result = importOpml(xml, []);
  assert.equal(result.added.length, 1);
  assert.equal(result.duplicates, 1);
  assert.equal(result.invalid, 1);
  assert.equal(result.added[0].folder, "Tech");
  const again = importOpml(exportOpml(result.added), []);
  assert.equal(again.added[0].name, "News & tools");
  assert.equal(again.added[0].folder, "Tech");
  assert.equal(importOpml(xml, result.added).added.length, 0);
  assert.throws(() => importOpml('<!DOCTYPE opml><opml/>', []));
  assert.throws(() => importOpml(`<opml><body>${'<outline text="nested">'.repeat(40)}${'</outline>'.repeat(40)}</body></opml>`, []), /depth/);
});
