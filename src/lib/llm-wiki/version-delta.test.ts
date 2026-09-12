import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { compareEvidence } from "./version-delta";
import type { SourceVersionId } from "./types";
const from = randomUUID() as SourceVersionId, to = randomUUID() as SourceVersionId;

test("delta detects sections, numerical tokens and references without claiming semantics", async () => {
  const result = await compareEvidence(from, to,
    "# Findings\n10% succeeded.\n## Removed\n[Old](https://example.org/old)",
    "# Findings\n20% succeeded.\n## Added\n[New](https://example.org/new)");
  assert.deepEqual(result.sections.added, ["## Added [1]"]);
  assert.deepEqual(result.sections.removed, ["## Removed [1]"]);
  assert.deepEqual(result.sections.modified, ["# Findings [1]"]);
  assert.deepEqual(result.numbers, { added: ["20%"], removed: ["10%"] });
  assert.deepEqual(result.references, { added: ["https://example.org/new"], removed: ["https://example.org/old"] });
  assert.equal(result.semantic.status, "not-run");
  const same = await compareEvidence(from, to, "plain body", "plain body");
  assert.deepEqual(same.sections, { added: [], removed: [], modified: [] });
});

test("semantic analysis accepts quoted findings and rejects invented evidence or extra schema", async () => {
  const change = { kind: "claim", before: "10%", after: "20%", reason: "Reported rate increased." };
  const result = await compareEvidence(from, to, "10%", "20%", { async decide(prompt) {
    assert.ok(prompt.includes("untrusted"));
    return JSON.stringify({ changes: [change] });
  } });
  assert.deepEqual(result.semantic.changes, [change]);
  for (const invalid of [{ ...change, after: "90%" }, { ...change, before: null, after: null }, { ...change, kind: "execute" }]) {
    await assert.rejects(compareEvidence(from, to, "10%", "20%", { async decide() { return JSON.stringify({ changes: [invalid] }); } }));
  }
});

test("semantic timeouts abort, and bounded comparisons disclose truncation", async () => {
  let signal: AbortSignal | undefined;
  await assert.rejects(compareEvidence(from, to, "old", "new", { decide(_, captured) {
    signal = captured; return new Promise(() => {});
  } }, 5), /timed out/);
  assert.equal(signal?.aborted, true);
  const large = Array.from({ length: 120 }, (_, index) => `# Section ${index}\n${"body ".repeat(100)}`).join("\n");
  const result = await compareEvidence(from, to, "", large, { async decide(prompt) {
    assert.ok(prompt.length < 34_000); return '{"changes":[]}';
  } });
  assert.equal(result.truncated, true);
  assert.equal(result.sections.added.length, 100);
  assert.equal(result.semantic.inputTruncated, true);
});
