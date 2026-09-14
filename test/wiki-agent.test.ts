import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initializeWikiCabinet } from "../src/lib/llm-wiki/config";
import { WikiAgentRunner } from "../server/ingestion/wiki-agent";
import type { AgentPersona } from "../src/lib/agents/persona-manager";
import type { AdapterExecutionResult } from "../src/lib/agents/adapters/types";

const persona = { slug: "wiki-stub", provider: "claude-code" } as unknown as AgentPersona;
const ok = (output = "Wiki updated."): AdapterExecutionResult => ({ exitCode: 0, signal: null, timedOut: false, output });

const sourcePage = `---
title: My Note
type: source-summary
source_id: abc12345-0000-0000-0000-000000000000
cabinet_id: cab
current_version: 1
current_version_id: ver-1
source_status: active
created: 2026-01-01
updated: 2026-01-01
sources: []
tags: []
---

# My Note

## Summary

- A checked statement [E1]

## Evidence

- E1: "quote" ([Raw v1](../../raw/x/v1/source.md))

## Source provenance

- Source: abc12345-0000-0000-0000-000000000000
`;

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-wiki-agent-"));
  await fs.writeFile(path.join(root, ".cabinet"), "kind: root\nname: My Study\n");
  await initializeWikiCabinet(root, { enabled: true });
  await fs.mkdir(path.join(root, "wiki/sources"), { recursive: true });
  await fs.mkdir(path.join(root, "raw/x/v1"), { recursive: true });
  await fs.writeFile(path.join(root, "wiki/sources/my-note.md"), sourcePage);
  await fs.writeFile(path.join(root, "raw/x/v1/source.md"), "# Evidence\n");
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const task = { kind: "ingest" as const, sourceId: "abc12345-0000-0000-0000-000000000000", sourcePage: "wiki/sources/my-note.md", rawMarkdownPath: "raw/x/v1/source.md", title: "My Note", batch: false };
  return { root, task };
}

test("agent edits under wiki/ are accepted, indexed, logged and frontmatter-repaired", async (t) => {
  const f = await fixture(t);
  const runner = new WikiAgentRunner(f.root, {
    persona,
    async execute(ctx) {
      assert.equal(ctx.cwd, f.root);
      assert.ok(String(ctx.config?.systemPrompt).includes("Guardrails"));
      await fs.mkdir(path.join(f.root, "wiki/entities"), { recursive: true });
      await fs.writeFile(path.join(f.root, "wiki/entities/thing.md"), "# Thing\n\nBody without frontmatter.\n");
      return ok("Created wiki/entities/thing.md");
    },
  });
  const result = await runner.run(f.task, {}, "job-1", new AbortController().signal);
  assert.ok(result.created.includes("wiki/entities/thing.md"));
  const page = await fs.readFile(path.join(f.root, "wiki/entities/thing.md"), "utf8");
  assert.match(page, /^---\n[\s\S]*type: entity[\s\S]*---\n/);
  const index = await fs.readFile(path.join(f.root, "wiki/index.md"), "utf8");
  assert.match(index, /entities\/thing\.md/);
  const log = await fs.readFile(path.join(f.root, "wiki/log.md"), "utf8");
  assert.match(log, /ingest \| My Note/);
  assert.match(log, /Job: job-1/);
  assert.ok(await fs.stat(path.join(f.root, "wiki/SCHEMA.md")).then(() => true, () => false));
});

test("raw edits are restored, outside-wiki writes are report-only, executable pages reverted", async (t) => {
  const f = await fixture(t);
  const runner = new WikiAgentRunner(f.root, {
    persona,
    async execute() {
      await fs.writeFile(path.join(f.root, "raw/x/v1/source.md"), "# Tampered\n");
      await fs.mkdir(path.join(f.root, "Inbox"), { recursive: true });
      await fs.writeFile(path.join(f.root, "Inbox/escape.md"), "outside");
      await fs.writeFile(path.join(f.root, "wiki/concepts/bad.md"), "---\ntitle: Bad\n---\n\n<script>alert(1)</script>\n");
      return ok();
    },
  });
  const result = await runner.run(f.task, {}, "job-2", new AbortController().signal);
  assert.equal(await fs.readFile(path.join(f.root, "raw/x/v1/source.md"), "utf8"), "# Evidence\n");
  assert.equal(await fs.readFile(path.join(f.root, "Inbox/escape.md"), "utf8"), "outside");
  assert.ok(result.warnings.some((warning) => warning.includes("raw evidence")));
  assert.ok(result.warnings.some((warning) => warning.includes("outside the Wiki scope")));
  assert.ok(result.warnings.some((warning) => warning.includes("bad.md")));
  await assert.rejects(fs.stat(path.join(f.root, "wiki/concepts/bad.md")));
});

test("protected source-summary frontmatter and sections are reverted", async (t) => {
  const f = await fixture(t);
  const runner = new WikiAgentRunner(f.root, {
    persona,
    async execute() {
      await fs.writeFile(path.join(f.root, "wiki/sources/my-note.md"), sourcePage.replace("source_status: active", "source_status: deleted"));
      return ok();
    },
  });
  const result = await runner.run(f.task, {}, "job-3", new AbortController().signal);
  assert.equal(await fs.readFile(path.join(f.root, "wiki/sources/my-note.md"), "utf8"), sourcePage);
  assert.ok(result.warnings.some((warning) => warning.includes("protected source-summary")));
});

test("HTML comments in agent-edited pages are allowed while scripts are reverted", async (t) => {
  const f = await fixture(t);
  const runner = new WikiAgentRunner(f.root, {
    persona,
    async execute() {
      const overview = await fs.readFile(path.join(f.root, "wiki/overview.md"), "utf8");
      await fs.writeFile(path.join(f.root, "wiki/overview.md"), `${overview}\n<!-- Themes -->\nMore prose.\n`);
      await fs.writeFile(path.join(f.root, "wiki/concepts/evil.md"), "---\ntitle: Evil\n---\n\n<script>alert(1)</script>\n");
      return ok();
    },
  });
  const result = await runner.run(f.task, {}, "job-3b", new AbortController().signal);
  const overview = await fs.readFile(path.join(f.root, "wiki/overview.md"), "utf8");
  assert.match(overview, /<!-- Themes -->/);
  assert.ok(!result.warnings.some((warning) => warning.includes("overview.md")));
  assert.ok(result.warnings.some((warning) => warning.includes("evil.md")));
  await assert.rejects(fs.stat(path.join(f.root, "wiki/concepts/evil.md")));
});

test("wiki-only edits and cabinet-state churn produce no outside-scope warning", async (t) => {
  const f = await fixture(t);
  await new Promise((resolve, reject) => execFile("git", ["init"], { cwd: f.root }, (error) => error ? reject(error) : resolve(undefined)));
  const runner = new WikiAgentRunner(f.root, {
    persona,
    async execute() {
      await fs.mkdir(path.join(f.root, ".cabinet-state"), { recursive: true });
      await fs.writeFile(path.join(f.root, ".cabinet-state/file-history.jsonl"), "{}\n");
      await fs.writeFile(path.join(f.root, "wiki/entities/thing.md"), "# Thing\n");
      return ok();
    },
  });
  const result = await runner.run(f.task, {}, "job-3c", new AbortController().signal);
  assert.ok(!result.warnings.some((warning) => warning.includes("outside the Wiki scope")), result.warnings.join("; "));
});

test("a failed agent run still restores raw evidence and logs a failed entry", async (t) => {
  const f = await fixture(t);
  const runner = new WikiAgentRunner(f.root, {
    persona,
    async execute() {
      await fs.writeFile(path.join(f.root, "raw/x/v1/source.md"), "# Tampered\n");
      return { exitCode: 1, signal: null, timedOut: false, errorMessage: "agent exploded" };
    },
  });
  await assert.rejects(runner.run(f.task, {}, "job-3d", new AbortController().signal), /agent exploded/);
  assert.equal(await fs.readFile(path.join(f.root, "raw/x/v1/source.md"), "utf8"), "# Evidence\n");
  const log = await fs.readFile(path.join(f.root, "wiki/log.md"), "utf8");
  assert.match(log, /ingest \(failed\) \| My Note/);
});

test("concept-table rows linked by wikilink or relative markdown link are not drift", async (t) => {
  const f = await fixture(t);
  const runner = new WikiAgentRunner(f.root, {
    persona,
    async execute() {
      await fs.writeFile(path.join(f.root, "wiki/concepts/ai-adoption.md"), "# AI adoption\n");
      await fs.writeFile(path.join(f.root, "wiki/concepts/foo.md"), "# Foo\n");
      await fs.writeFile(path.join(f.root, "wiki/concept-table.md"),
        "---\ntitle: Concept Table\ntype: concept-table\n---\n\n## Concepts\n\n" +
        "| Concept | Working definition | Role in this wiki | Sources | Related pages | Status | Maintenance note |\n" +
        "|---|---|---|---|---|---|---|\n" +
        "| [[ai-adoption|AI adoption]] | d | r | s | p | ok | n |\n" +
        "| [Foo](../concepts/foo.md) | d | r | s | p | ok | n |\n");
      return ok();
    },
  });
  const result = await runner.run(f.task, {}, "job-5a", new AbortController().signal);
  assert.ok(!result.warnings.some((warning) => warning.includes("Concept table")), result.warnings.join("; "));
});

test("the ingest prompt embeds the summary, index and concept table unless batched", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "wiki/index.md"), "# Index\n\n- sources/my-note.md\n");
  let prompt = "";
  const runner = new WikiAgentRunner(f.root, {
    persona,
    async execute(ctx) { prompt = ctx.prompt; return ok(); },
  });
  await runner.run(f.task, {}, "job-7", new AbortController().signal);
  assert.match(prompt, /=== Source summary \(wiki\/sources\/my-note\.md\) ===\n[\s\S]*A checked statement \[E1\]/);
  assert.match(prompt, /=== wiki\/index\.md ===\n/);
  assert.match(prompt, /=== wiki\/concept-table\.md ===\n/);
  assert.match(prompt, /do not re-read them/);
  await runner.run({ ...f.task, batch: true }, {}, "job-8", new AbortController().signal);
  assert.doesNotMatch(prompt, /=== wiki\/concept-table\.md ===/);
});

test("settings.agentModel overrides the persona model and drops persona effort", async (t) => {
  const f = await fixture(t);
  let config: Record<string, unknown> = {};
  const runner = new WikiAgentRunner(f.root, {
    persona: { slug: "wiki-stub", provider: "claude-code", model: "persona-model", effort: "high" } as unknown as AgentPersona,
    async execute(ctx) { config = ctx.config as Record<string, unknown>; return ok(); },
  });
  await runner.run(f.task, {}, "job-9", new AbortController().signal);
  assert.equal(config.model, "persona-model");
  assert.equal(config.effort, "high");
  await runner.run(f.task, { agentModel: "gemini-3.8-flash-medium" }, "job-10", new AbortController().signal);
  assert.equal(config.model, "gemini-3.8-flash-medium");
  assert.equal(config.effort, undefined);
});

test("the report drops tool transcript lines and keeps the final message", async (t) => {
  const f = await fixture(t);
  const runner = new WikiAgentRunner(f.root, {
    persona,
    async execute() {
      return ok("Working on it.\n$ find . -name 'x.md'\n[tool failed: permission denied]\n\nAll pages updated and cross-linked.");
    },
  });
  const result = await runner.run(f.task, {}, "job-5b", new AbortController().signal);
  assert.equal(result.report, "Working on it.\n\nAll pages updated and cross-linked.");
  const log = await fs.readFile(path.join(f.root, "wiki/log.md"), "utf8");
  assert.match(log, /Notes: Working on it\. All pages updated/);
  assert.doesNotMatch(log, /tool failed|\$ find/);
});

test("a missing agent fails clearly and a timed-out run fails", async (t) => {
  const f = await fixture(t);
  assert.equal(new WikiAgentRunner(f.root).hasAgent({}), false);
  await assert.rejects(new WikiAgentRunner(f.root).run(f.task, {}, "job-4", new AbortController().signal), /Choose a Cabinet agent/);
  const runner = new WikiAgentRunner(f.root, { persona, async execute() { return { exitCode: null, signal: "SIGTERM", timedOut: true }; } });
  await assert.rejects(runner.run(f.task, {}, "job-5", new AbortController().signal), /timed out/);
});
