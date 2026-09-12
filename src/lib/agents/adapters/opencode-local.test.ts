import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openCodeLocalAdapter } from "./opencode-local";

async function createExecutableScript(source: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-opencode-local-test-"));
  const scriptPath = path.join(dir, "fake-opencode.sh");
  await fs.writeFile(scriptPath, source, "utf8");
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
}

test("openCodeLocalAdapter parses JSONL run output, usage, and session id", async () => {
  const scriptPath = await createExecutableScript(`#!/bin/sh
cat >/dev/null
printf '%s\n' \
  '{"type":"text","sessionID":"session-oc-1","part":{"text":"Reading files."}}' \
  '{"type":"step_finish","sessionID":"session-oc-1","part":{"tokens":{"input":100,"output":20,"reasoning":5,"cache":{"read":30}},"cost":0.0018}}' \
  '{"type":"text","sessionID":"session-oc-1","part":{"text":"Done."}}'
`);

  const chunks: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
  const result = await openCodeLocalAdapter.execute?.({
    runId: "run-oc-1",
    adapterType: "opencode_local",
    config: {
      command: scriptPath,
      model: "openai/gpt-5.2-codex",
      variant: "medium",
    },
    prompt: "Inspect the repo",
    cwd: process.cwd(),
    onLog: async (stream, chunk) => {
      chunks.push({ stream, chunk });
    },
  });

  assert.ok(result);
  assert.equal(result.exitCode, 0);
  assert.equal(result.sessionId, "session-oc-1");
  assert.equal(result.sessionDisplayId, "session-oc-1");
  assert.equal(result.provider, "openai");
  assert.equal(result.model, "openai/gpt-5.2-codex");
  assert.deepEqual(result.usage, {
    inputTokens: 100,
    outputTokens: 25,
    cachedInputTokens: 30,
  });
  assert.equal(result.output, "Reading files.\nDone.");
  assert.equal(result.summary, "Done.");
  assert.deepEqual(result.sessionParams, {
    sessionId: "session-oc-1",
    cwd: process.cwd(),
  });
  assert.deepEqual(chunks, [
    { stream: "stdout", chunk: "Reading files.\nDone.\n" },
  ]);
});

test("openCodeLocalAdapter inferenceOnly denies all tools via config env, no session", async () => {
  const scriptPath = await createExecutableScript(`#!/bin/sh
cat >/dev/null
printf '%s\n' \
  '{"type":"text","sessionID":"session-oc-wiki","part":{"text":"{\\"summary\\":[]}"}}' \
  '{"type":"step_finish","sessionID":"session-oc-wiki","part":{"tokens":{"input":10,"output":4,"reasoning":0,"cache":{"read":0}},"cost":0}}'
`);

  let capturedArgs: string[] = [];
  let capturedEnv: Record<string, string> = {};
  const result = await openCodeLocalAdapter.execute?.({
    runId: "wiki",
    adapterType: "opencode_local",
    config: { command: scriptPath, inferenceOnly: true },
    prompt: "Evidence",
    cwd: process.cwd(),
    sessionParams: { sessionId: "old-session", cwd: "/tmp" },
    onLog: async () => {},
    onMeta: async (meta) => {
      capturedArgs = meta.commandArgs ?? [];
      capturedEnv = meta.env ?? {};
    },
  });

  assert.ok(result);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, '{"summary":[]}');
  assert.equal(capturedArgs.includes("--session"), false);
  assert.match(
    capturedEnv.OPENCODE_CONFIG_CONTENT ?? "",
    /"permission":\{"\*":"deny"\}/
  );
});

test("opencode session codec round-trips session params", () => {
  const codec = openCodeLocalAdapter.sessionCodec;
  assert.ok(codec);

  const serialized = codec.serialize({ sessionId: "oc-1", cwd: "/repo" });
  assert.deepEqual(serialized, { sessionId: "oc-1", cwd: "/repo" });

  const deserialized = codec.deserialize({ sessionId: "oc-1" });
  assert.deepEqual(deserialized, { sessionId: "oc-1" });

  assert.equal(codec.serialize({}), null);
  assert.equal(codec.deserialize({}), null);
});
