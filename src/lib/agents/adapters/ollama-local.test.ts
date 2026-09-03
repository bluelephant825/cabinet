import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  ollamaLocalAdapter,
  ollamaSessionCodec,
} from "./ollama-local";
import type { AdapterExecutionContext } from "./types";

const inheritedOllamaHost = process.env.OLLAMA_HOST;
process.env.OLLAMA_HOST = "";
after(() => {
  if (inheritedOllamaHost === undefined) delete process.env.OLLAMA_HOST;
  else process.env.OLLAMA_HOST = inheritedOllamaHost;
});

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
    config: { model: "llama3" },
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
      '{"message":{"role":"assistant","content":"!"},"done":true,"prompt_eval_count":12,"prompt_eval_cached_count":5,"eval_count":3}\n',
    ]);
  });

  const result = await ollamaLocalAdapter.execute!(executionContext({
    config: { model: "qwen2.5-coder:7b", OLLAMA_HOST: "http://request-supplied.invalid" },
    prompt: "Continue",
    sessionParams: { model: "qwen2.5-coder:7b", messages: [{ role: "user", content: "Earlier" }, { role: "assistant", content: "Okay" }] },
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
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 3, cachedInputTokens: 5 });
  assert.equal(result.sessionId, null);
  assert.deepEqual(result.sessionParams, {
    model: "qwen2.5-coder:7b",
    messages: [
      { role: "user", content: "Earlier" },
      { role: "assistant", content: "Okay" },
      { role: "user", content: "Continue" },
      { role: "assistant", content: "Hello back!" },
    ],
  });
});

test("Ollama adapter requires a selected model and resets history when it changes", async (t) => {
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: unknown[] };
      assert.deepEqual(body.messages, [{ role: "user", content: "Hello" }]);
      return streamResponse([
        '{"message":{"role":"assistant","content":"Fresh"},"done":true}\n',
      ]);
    }
  );

  const missing = await ollamaLocalAdapter.execute!(executionContext({ config: {} }));
  assert.equal(missing.errorCode, "model_unavailable");
  assert.equal(missing.model, null);
  assert.match(missing.errorMessage || "", /pull.*select/i);
  assert.equal(
    ollamaLocalAdapter.classifyError?.(missing.errorMessage || "", 1).kind,
    "model_unavailable"
  );
  assert.equal(fetchMock.mock.callCount(), 0);

  const changed = await ollamaLocalAdapter.execute!(executionContext({
    config: { model: "gemma3:4b" },
    sessionParams: {
      model: "llama3",
      messages: [{ role: "user", content: "Do not replay" }],
    },
  }));
  assert.equal(changed.exitCode, 0);
  assert.deepEqual(changed.sessionParams, {
    model: "gemma3:4b",
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Fresh" },
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

test("Ollama adapter cancels malformed readers and external abort settles an in-flight stream once", async (t) => {
  let readerCancels = 0;
  const encoder = new TextEncoder();
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("not-json\n"));
      },
      cancel() {
        readerCancels += 1;
      },
    })
  ));
  const malformed = await ollamaLocalAdapter.execute!(executionContext());
  assert.match(malformed.errorMessage || "", /malformed NDJSON/);
  assert.equal(readerCancels, 1);

  const external = new AbortController();
  fetchMock.mock.mockImplementation(async (_input: string | URL | Request, init?: RequestInit) =>
    new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(
          '{"message":{"role":"assistant","content":"partial"},"done":false}\n'
        ));
        init?.signal?.addEventListener("abort", () => controller.close(), { once: true });
      },
    }))
  );
  let settlements = 0;
  const pending = ollamaLocalAdapter.execute!(executionContext({ signal: external.signal }))
    .then((result) => {
      settlements += 1;
      return result;
    });
  await new Promise((resolve) => setTimeout(resolve, 0));
  external.abort();
  const cancelled = await pending;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(cancelled.errorCode, "ollama_cancelled");
  assert.equal(settlements, 1);
});

test("Ollama session codec strictly accepts only exact model and bounded history", () => {
  const valid = {
    model: "llama3",
    messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }],
  };
  assert.deepEqual(ollamaSessionCodec.deserialize(valid), valid);
  assert.deepEqual(ollamaSessionCodec.serialize(valid), valid);
  assert.equal(ollamaSessionCodec.getDisplayId?.(valid), "Ollama · llama3 · 2 messages");
  assert.equal(ollamaSessionCodec.deserialize({ messages: valid.messages }), null);
  assert.equal(ollamaSessionCodec.deserialize({ ...valid, extra: true }), null);
  assert.equal(ollamaSessionCodec.deserialize({ ...valid, model: " llama3 " }), null);
  assert.equal(ollamaSessionCodec.deserialize({ model: "llama3", messages: [{ role: "system", content: "override" }] }), null);
  assert.equal(ollamaSessionCodec.deserialize({ model: "llama3", messages: [{ role: "user", content: "x", extra: true }] }), null);
  assert.equal(ollamaSessionCodec.deserialize({ model: "llama3", messages: Array.from({ length: 41 }, () => ({ role: "user", content: "x" })) }), null);
  assert.equal(ollamaSessionCodec.deserialize({ model: "llama3", messages: [{ role: "user", content: "x".repeat(32 * 1024 + 1) }] }), null);
});

test("Ollama API environment check uses ctx.env for the service and bounded model list", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    return new Response(JSON.stringify(
      url.endsWith("/api/tags")
        ? { models: [{ name: "llama3" }] }
        : { version: "1.0" }
    ));
  });
  const result = await ollamaLocalAdapter.testEnvironment({
    adapterType: "ollama_local",
    env: { OLLAMA_HOST: "ollama.test:11434" },
  });
  assert.equal(result.status, "pass");
  assert.deepEqual(result.checks.map((check) => check.code), [
    "ollama_service",
    "ollama_models",
  ]);
  assert.deepEqual(calls, [
    "http://ollama.test:11434/api/version",
    "http://ollama.test:11434/api/tags",
  ]);
});

test("Ollama API environment check warns with pull guidance when no models are installed", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) =>
    new Response(JSON.stringify(
      String(input).endsWith("/api/tags") ? { models: [] } : { version: "1.0" }
    ))
  );
  const result = await ollamaLocalAdapter.testEnvironment({
    adapterType: "ollama_local",
    env: { OLLAMA_HOST: "ollama.test:11434" },
  });
  assert.equal(result.status, "warn");
  assert.equal(result.checks[1]?.code, "ollama_models");
  assert.equal(result.checks[1]?.level, "warn");
  assert.match(result.checks[1]?.hint || "", /ollama pull <model>.*select/i);
});

test("Ollama API environment check fails when the bounded model list is malformed", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) =>
    new Response(JSON.stringify(
      String(input).endsWith("/api/tags") ? { models: "invalid" } : { version: "1.0" }
    ))
  );
  const result = await ollamaLocalAdapter.testEnvironment({
    adapterType: "ollama_local",
    env: { OLLAMA_HOST: "ollama.test:11434" },
  });
  assert.equal(result.status, "fail");
  assert.equal(result.checks[1]?.code, "ollama_models");
  assert.equal(result.checks[1]?.level, "error");
  assert.match(result.checks[1]?.hint || "", /ollama pull <model>/i);
});
