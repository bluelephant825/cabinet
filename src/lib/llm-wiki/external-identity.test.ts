import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WikidataIdentityProvider, resolveExternalIdentity, externalIdentityMetadata, type ExternalIdentityCandidate, type IdentityAssessmentModel } from "./external-identity";
import type { SemanticCandidate } from "./semantic-extraction";
import type { SourceId, SourceVersionId } from "./types";
const candidate: SemanticCandidate = { id: "candidate", kind: "entity", category: "software", name: "Cabinet", description: "Knowledge software.", evidence: { sourceId: randomUUID() as SourceId, versionId: randomUUID() as SourceVersionId, quote: "Cabinet stores knowledge.", start: 0, end: 24 } };
const choice: ExternalIdentityCandidate = { qid: "Q123", label: "Cabinet", aliases: [], description: "Knowledge software", types: [{ qid: "Q7397", label: "software" }], wikipedia: "https://en.wikipedia.org/wiki/Cabinet_(software)" };
const yes: IdentityAssessmentModel = { async assess(input) { return { assessments: input.choices.map((item) => ({ qid: item.qid, labelMatch: true, typeMatch: true, contextMatch: true, reason: "The type and Source context identify the software." })) }; } };
const signal = () => new AbortController().signal;

test("external identity requires lexical, type and contextual agreement and preserves ambiguity", async () => {
  const provider = { async search() { return [choice]; } };
  assert.equal((await resolveExternalIdentity(candidate, { provider }, signal())).status, "review");
  const resolved = await resolveExternalIdentity(candidate, { provider, model: yes }, signal());
  assert.equal(resolved.status, "resolved");
  assert.deepEqual(externalIdentityMetadata(resolved), { wikidata: "Q123", wikipedia: choice.wikipedia });
  for (const choices of [[choice, { ...choice, qid: "Q124" }], [{ ...choice, types: [] }], [{ ...choice, label: "Other" }], [{ ...choice, description: "" }]]) {
    assert.equal((await resolveExternalIdentity(candidate, { provider: { async search() { return choices; } }, model: yes }, signal())).status, "review");
  }
  assert.equal((await resolveExternalIdentity(candidate, { provider: { async search() { return []; } } }, signal())).status, "unmatched");
});

test("identity validation rejects fabricated decisions, malicious URLs and provider errors", async () => {
  for (const wikipedia of ["https://evil.test/wiki/Cabinet", "javascript:alert(1)", "https://en.wikipedia.org.evil.test/wiki/Cabinet", "https://user@en.wikipedia.org/wiki/Cabinet"]) {
    await assert.rejects(resolveExternalIdentity(candidate, { provider: { async search() { return [{ ...choice, wikipedia }]; } }, model: yes }, signal()));
  }
  await assert.rejects(resolveExternalIdentity(candidate, { provider: { async search() { return [choice]; } }, model: { async assess() { return { assessments: [{ qid: "Q999", labelMatch: true, typeMatch: true, contextMatch: true, reason: "Invented" }] }; } } }, signal()), /Unknown/);
  await assert.rejects(resolveExternalIdentity(candidate, { provider: { async search() { throw new Error("offline"); } } }, signal()), /offline/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(resolveExternalIdentity(candidate, { provider: { async search() { assert.fail("No network when aborted"); } } }, controller.signal));
});

test("Wikidata adapter searches fixed endpoints and derives sitelinks without sending Source context", async () => {
  const requests: URL[] = [];
  const fake: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); requests.push(url);
    assert.equal(url.origin + url.pathname, "https://www.wikidata.org/w/api.php");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, "omit");
    assert.ok((init?.headers as Record<string, string>)["User-Agent"]);
    assert.doesNotMatch(url.href, /stores|knowledge/);
    if (url.searchParams.get("action") === "wbsearchentities") return Response.json({ search: [{ id: "Q123" }] });
    if (url.searchParams.get("ids") === "Q7397") return Response.json({ entities: { Q7397: { labels: { en: { value: "software" } } } } });
    return Response.json({ entities: { Q123: { id: "Q123", labels: { en: { value: "Cabinet" } }, descriptions: { en: { value: "Knowledge software" } }, aliases: { en: [{ value: "Cabinet app" }] }, claims: { P31: [{ rank: "normal", mainsnak: { snaktype: "value", datavalue: { value: { id: "Q7397" } } } }] }, sitelinks: { enwiki: { title: "Cabinet (software)" } } } } });
  };
  const result = await new WikidataIdentityProvider("Cabinet-test/1.0 (test)", "en", fake).search("Cabinet", signal());
  assert.equal(requests.length, 3);
  assert.equal(result[0].qid, "Q123");
  assert.equal(result[0].types[0].label, "software");
  assert.equal(result[0].wikipedia, "https://en.wikipedia.org/wiki/Cabinet_(software)");
});

test("Wikidata errors, rate limits and excessive bodies fail instead of becoming no-match results", async () => {
  for (const response of [() => Response.json({ error: { code: "maxlag" } }), () => new Response("busy", { status: 429 }), () => new Response("x".repeat(2 * 1024 * 1024 + 1)), () => Response.json({ search: [{ id: "bad" }] })]) {
    await assert.rejects(new WikidataIdentityProvider("Cabinet-test/1.0", "en", async () => response()).search("Cabinet", signal()));
  }
});

import { resolveOptionalIdentities } from "./external-identity";
test("optional identity failures and a bounded timeout remain unavailable while parent cancellation propagates", async () => {
  const failed = await resolveOptionalIdentities([candidate], { provider: { async search() { throw new Error("rate limited"); } } }, signal());
  assert.equal(failed[0].status, "unavailable");
  let observed: AbortSignal | undefined;
  const timed = await resolveOptionalIdentities([candidate], { provider: { search(_, received) { observed = received; return new Promise(() => {}); } } }, signal(), 5);
  assert.equal(timed[0].status, "unavailable");
  assert.equal(observed?.aborted, true);
  const controller = new AbortController();
  await assert.rejects(resolveOptionalIdentities([candidate], { provider: { search() { controller.abort(); return new Promise(() => {}); } } }, controller.signal, 100));
});
