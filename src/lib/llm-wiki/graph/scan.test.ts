import test from "node:test";
import assert from "node:assert/strict";
import { scanWikiGraph, type ScanPage, type ScanSource } from "./scan";
import type { WikiProvenance } from "../wiki-provenance";

const SRC = "abc12345-0000-4000-8000-000000000001";
const VER = "abc12345-0000-4000-8000-000000000002";

const fm = (lines: string) => `---\n${lines}\n---\n\n`;

function fixturePages(): ScanPage[] {
  const provenance: WikiProvenance = {
    schemaVersion: 1, cabinetId: SRC as WikiProvenance["cabinetId"], roomPath: null,
    pagePath: "wiki/concepts/analytical-engine.md",
    knowledge: [
      { id: "claim-1", kind: "claim", text: "The Analytical Engine was never built.",
        supports: [{ sourceId: SRC as never, versionId: VER as never, quote: "never built", start: 0, end: 10 }],
        inactiveSupports: [{ sourceId: SRC as never, versionId: VER as never, quote: "old quote", start: 20, end: 29 }] },
      { id: "concept-1", kind: "concept", text: "Computing machinery.",
        supports: [{ sourceId: SRC as never, versionId: VER as never, quote: "machinery", start: 30, end: 39 }] },
    ],
  };
  return [
    { path: "wiki/index.md", markdown: "# Index\n", markdownHash: "h-index" },
    { path: "wiki/entities/ada-lovelace.md", markdownHash: "h-ada",
      markdown: fm("title: Ada Lovelace\ntype: entity\nsubtype: person\ntags: [history]") +
        "# Ada Lovelace\n\nFirst programmer.\n\n## Details\n\nMore text.\n" },
    { path: "wiki/entities/charles-babbage.md", markdownHash: "h-babbage",
      markdown: fm("title: Charles Babbage\ntype: entity") +
        "# Charles Babbage\n\nHe worked with [[Ada Lovelace]] and wrote [[Notes]].\n" },
    { path: "wiki/concepts/notes.md", markdownHash: "h-notes-c",
      markdown: fm("title: Notes\ntype: concept") + "# Notes\n\nA concept page.\n" },
    { path: "wiki/synthesis/notes.md", markdownHash: "h-notes-s",
      markdown: fm("title: Notes synthesis\ntype: synthesis") + "# Notes\n\nA synthesis page.\n" },
    { path: "wiki/concepts/analytical-engine.md", markdownHash: "h-engine", provenance,
      markdown: fm("title: Analytical Engine\ntype: concept\nsources: [source-a, missing-slug]\ntags: [computing, 7]") +
        "# Analytical Engine\n\nSee [Ada](../entities/ada-lovelace.md) for the operator.\n" },
    { path: "wiki/sources/source-a.md", markdownHash: "h-src-a",
      markdown: fm(`title: Source A\ntype: source-summary\nsource_id: ${SRC}`) + "# Source A\n\nSummary.\n" },
    { path: "wiki/sources/source-b.md", markdownHash: "h-src-b",
      markdown: fm("title: Source B\ntype: source-summary\nsource_id: missing-source") + "# Source B\n\nSummary.\n" },
    { path: "wiki/concept-table.md", markdownHash: "h-table",
      markdown: fm("title: Concept Table\ntype: concept-table") +
        "## Concept Clusters\n\n| Cluster | Concepts | Current interpretation |\n| --- | --- | --- |\n" +
        "| Foundations | [[analytical-engine]], Ada Lovelace, ghost | Early computing |\n" },
    { path: "wiki/log.md", markdown: "# Log\n", markdownHash: "h-log" },
    { path: "wiki/graph.json", markdown: "{}", markdownHash: "h-graph" },
    { path: "notes/escape.md", markdown: "# Outside\n", markdownHash: "h-out" },
  ];
}

const fixtureSources = (): ScanSource[] => [
  { id: SRC, title: "Source A raw", rawPath: "raw/notes/source-a", status: "active", currentVersionId: VER },
];

const input = () => ({ wikiRoot: "wiki", cabinetId: "cab-1", pages: fixturePages(), sources: fixtureSources() });

test("scan builds page, source, topic and claim nodes", () => {
  const { nodes } = scanWikiGraph(input());
  const ids = new Set(nodes.map((node) => node.id));
  assert.ok(ids.has("page:entities/ada-lovelace"));
  assert.ok(ids.has("page:concept-table"));
  assert.ok(ids.has(`source:${SRC}`));
  assert.ok(ids.has("topic:history"));
  assert.ok(ids.has("topic:person"));
  assert.ok(ids.has("topic:computing"));
  assert.ok(ids.has("topic:cluster-foundations"));
  assert.ok(ids.has("claim:claim-1"));
  assert.ok(!ids.has("claim:concept-1"));
  assert.ok(!ids.has("page:index"));
  assert.ok(!ids.has("page:log"));
  const ada = nodes.find((node) => node.id === "page:entities/ada-lovelace")!;
  assert.equal(ada.name, "Ada Lovelace");
  assert.equal(ada.summary, "First programmer.");
  assert.equal(ada.pageKind, "entity");
  assert.equal(ada.category, "person");
  assert.deepEqual(ada.tags, ["history"]);
  const table = nodes.find((node) => node.id === "page:concept-table")!;
  assert.equal(table.pageKind, "concept-table");
  const engine = nodes.find((node) => node.id === "page:concepts/analytical-engine")!;
  assert.deepEqual(engine.tags, ["computing"]);
  const claim = nodes.find((node) => node.id === "claim:claim-1")!;
  assert.equal(claim.summary, "The Analytical Engine was never built.");
  const source = nodes.find((node) => node.id === `source:${SRC}`)!;
  assert.equal(source.summary, "Raw source (active)");
});

test("scan resolves wikilinks, markdown links and reports unresolved targets", () => {
  const { edges, warnings, unresolvedLinks } = scanWikiGraph(input());
  const key = (edge: { source: string; target: string; type: string }) => `${edge.source}|${edge.target}|${edge.type}`;
  const set = new Set(edges.map(key));
  assert.ok(set.has("page:entities/charles-babbage|page:entities/ada-lovelace|links_to"));
  assert.ok(set.has("page:concepts/analytical-engine|page:entities/ada-lovelace|links_to"));
  assert.ok(!set.has("page:entities/charles-babbage|page:concepts/notes|links_to"));
  assert.ok(!set.has("page:entities/charles-babbage|page:synthesis/notes|links_to"));
  assert.ok(warnings.some((warning) => warning === 'Unresolved wikilink "Notes" in wiki/entities/charles-babbage.md'));
  assert.ok(unresolvedLinks >= 2);
  const link = edges.find((edge) => edge.source === "page:entities/charles-babbage")!;
  assert.equal(link.extractor, "wikilink");
  assert.equal(link.confidence, 1);
  assert.equal(link.provenance, "explicit");
});

test("scan emits cites, categorized_under, part_of, asserts and supported_by", () => {
  const { edges, warnings } = scanWikiGraph(input());
  const key = (edge: { source: string; target: string; type: string; extractor?: string }) =>
    `${edge.source}|${edge.target}|${edge.type}`;
  const set = new Set(edges.map(key));
  assert.ok(set.has(`page:sources/source-a|source:${SRC}|cites`));
  assert.ok(edges.find((edge) => edge.type === "cites" && edge.extractor === "source-manifest"));
  assert.ok(set.has("page:concepts/analytical-engine|page:sources/source-a|cites"));
  assert.ok(set.has("page:entities/ada-lovelace|topic:history|categorized_under"));
  assert.ok(set.has("page:entities/ada-lovelace|topic:person|categorized_under"));
  assert.ok(set.has("page:concepts/analytical-engine|topic:cluster-foundations|part_of"));
  assert.ok(set.has("page:entities/ada-lovelace|topic:cluster-foundations|part_of"));
  assert.ok(set.has("page:concepts/analytical-engine|claim:claim-1|asserts"));
  assert.ok(set.has(`claim:claim-1|source:${SRC}|supported_by`));
  const support = edges.find((edge) => edge.type === "supported_by")!;
  assert.equal(support.evidence!.length, 1);
  assert.equal(support.evidence![0].quote, "never built");
  assert.equal(support.evidence![0].sourceId, SRC);
  assert.ok(warnings.some((warning) => warning.includes('source_id "missing-source"')));
  assert.ok(warnings.some((warning) => warning.includes('frontmatter source "missing-slug"')));
  assert.ok(warnings.some((warning) => warning.includes('cluster member "ghost"')));
});

test("a tag matching a page name categorizes under the page, not a duplicate topic", () => {
  const pages: ScanPage[] = [
    { path: "wiki/concepts/global-overshoot.md", markdownHash: "h1",
      markdown: fm("title: Global Overshoot\ntype: concept") + "# Global Overshoot\n" },
    { path: "wiki/concepts/limits-to-growth.md", markdownHash: "h2",
      markdown: fm("title: Limits to Growth\ntype: concept\ntags: [global-overshoot, limits-to-growth, big-tech, MCP]") +
        "# Limits to Growth\n" },
  ];
  const { nodes, edges } = scanWikiGraph({ wikiRoot: "wiki", cabinetId: "cab-1", pages, sources: [] });
  const ids = new Set(nodes.map((node) => node.id));
  assert.ok(!ids.has("topic:global-overshoot"));
  assert.ok(!ids.has("topic:limits-to-growth")); // self-tag produces no self-edge
  const set = new Set(edges.map((edge) => `${edge.source}|${edge.target}|${edge.type}`));
  assert.ok(set.has("page:concepts/limits-to-growth|page:concepts/global-overshoot|categorized_under"));
  assert.ok(!set.has("page:concepts/limits-to-growth|page:concepts/limits-to-growth|categorized_under"));
  // Remaining topics get humanized labels that keep original casing.
  assert.equal(nodes.find((node) => node.id === "topic:big-tech")!.name, "Big tech");
  assert.equal(nodes.find((node) => node.id === "topic:mcp")!.name, "MCP");
});

test("scan degrees and output are deterministic", () => {
  const first = scanWikiGraph(input());
  const second = scanWikiGraph(input());
  assert.deepEqual(first, second);
  const ada = first.nodes.find((node) => node.id === "page:entities/ada-lovelace")!;
  assert.equal(ada.degree, 5); // two inbound links, two topic edges, cluster part_of
  const ids = first.nodes.map((node) => node.id);
  assert.deepEqual(ids, [...ids].sort());
});
