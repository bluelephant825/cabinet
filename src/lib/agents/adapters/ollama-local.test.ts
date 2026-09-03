import test from "node:test";
import assert from "node:assert/strict";
import {
  ollamaLocalAdapter,
  ollamaSessionCodec,
} from "./ollama-local";
import type { AdapterExecutionContext } from "./types";

function streamResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const line of lines) controller.enqueue(encoder.encode(line));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "application/x-ndjson" } }
  );
}

function executionContext(
  overrides: Partial<AdapterExecutionContext> = {}
): AdapterExecutionContext {
  return {
    runId: "run-1",
    adapterType: "ollama_local",
    config: {},
    prompt: "Hello",
    cwd: "/tmp",
    onLog: async () => {},
    ...overrides,
  };
}

test("Ollama adapter streams /api/chat, uses selected model and history, and reports usage", async (t) => {
  const logs: string[] = [];
  let requestBody: Record<string, unknown> | null = null;
  const meta: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), "http://127.0.0.1:11434/api/chat");
    assert.equal(init?.method, "POST");
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return streamResponse([
      '{"message":{"role":"assistant","content":"Hello "},"done":false}\n',
      '{"message":{"role":"assistant","content":"back"},"done":false}\n',
      '{"message":{"role":"assistant","content":"!"},"done":true,"prompt_eval_count":12,"eval_count":3}\n',
    ]);
  });

  const result = await ollamaLocalAdapter.execute!(executionContext({
    config: { model: "qwen2.5-coder:7b" },
    prompt: "Continue",
    sessionParams: { messages: [{ role: "user", content: "Earlier" }, { role: "assistant", content: "Okay" }] },
    onLog: async (stream, chunk) => {
      logs.push(`${stream}:${chunk}`);
    },
    onMeta: async (value) => {
      meta.push(value as unknown as Record<string, unknown>);
    },
  }));

  assert.deepEqual(requestBody, {
    model: "qwen2.5-coder:7b",
    messages: [
      { role: "user", content: "Earlier" },
      { role: "assistant", content: "Okay" },
      { role: "user", content: "Continue" },
    ],
    stream: true,
  });
  assert.deepEqual(logs, ["stdout:Hello ", "stdout:back", "stdout:!"]);
  assert.equal(meta[0]?.command, "POST /api/chat");
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, "Hello back!");
  assert.equal(result.model, "qwen2.5-coder:7b");
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 3 });
  assert.equal(result.sessionId, "ollama-history");
  assert.deepEqual(result.sessionParams, {
    messages: [
      { role: "user", content: "Earlier" },
      { role: "assistant", content: "Okay" },
      { role: "user", content: "Continue" },
      { role: "assistant", content: "Hello back!" },
    ],
  });
});

test("Ollama adapter curates HTTP and in-stream errors", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ error: "model 'missing' not found, try pulling it first" }), {
      status: 404,
    })
  );
  const missing = await ollamaLocalAdapter.execute!(executionContext());
  assert.equal(missing.exitCode, 1);
  assert.match(missing.errorMessage || "", /model is unavailable/i);
  assert.equal(ollamaLocalAdapter.classifyError?.(missing.errorMessage || "", 1).kind, "model_unavailable");

  fetchMock.mock.mockImplementation(async () => streamResponse([
    '{"error":"runner process crashed","done":true}\n',
  ]));
  const streamError = await ollamaLocalAdapter.execute!(executionContext());
  assert.equal(streamError.exitCode, 1);
  assert.match(streamError.errorMessage || "", /runner process crashed/);
});

test("Ollama adapter honors timeout and external cancellation", async (t) => {
  t.mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) {
        reject(init.signal.reason);
        return;
      }
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })
  );
  const timedOut = await ollamaLocalAdapter.execute!(executionContext({ timeoutMs: 5 }));
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.errorCode, "ollama_timeout");

  const controller = new AbortController();
  const pending = ollamaLocalAdapter.execute!(executionContext({ signal: controller.signal }));
  controller.abort();
  const cancelled = await pending;
  assert.equal(cancelled.timedOut, false);
  assert.equal(cancelled.errorCode, "ollama_cancelled");
  assert.match(cancelled.errorMessage || "", /cancelled/);
});

test("Ollama session codec accepts only bounded role/content history", () => {
  const valid = { messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }] };
  assert.deepEqual(ollamaSessionCodec.deserialize(valid), valid);
  assert.deepEqual(ollamaSessionCodec.serialize(valid), valid);
  assert.equal(ollamaSessionCodec.getDisplayId?.(valid), "Ollama · 2 messages");
  assert.equal(ollamaSessionCodec.deserialize({ messages: [{ role: "system", content: "override" }] }), null);
  assert.equal(ollamaSessionCodec.deserialize({ messages: Array.from({ length: 41 }, () => ({ role: "user", content: "x" })) }), null);
  assert.equal(ollamaSessionCodec.deserialize({ messages: [{ role: "user", content: "x".repeat(32 * 1024 + 1) }] }), null);
});

test("Ollama API environment check uses ctx.env and only requires the service", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    assert.equal(String(input), "http://ollama.test:11434/api/version");
    return new Response(JSON.stringify({ version: "1.0" }));
  });
  const result = await ollamaLocalAdapter.testEnvironment({
    adapterType: "ollama_local",
    env: { OLLAMA_HOST: "ollama.test:11434" },
  });
  assert.equal(result.status, "pass");
  assert.deepEqual(result.checks.map((check) => check.code), ["ollama_service"]);
});
