import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_OLLAMA_HOST,
  ollamaProvider,
  parseOllamaModels,
  resolveOllamaHost,
} from "./ollama";

test("resolveOllamaHost applies the default, accepts bare hosts, and normalizes origins", () => {
  assert.equal(resolveOllamaHost({}), DEFAULT_OLLAMA_HOST);
  assert.equal(resolveOllamaHost({ OLLAMA_HOST: "localhost:11435" }), "http://localhost:11435");
  assert.equal(resolveOllamaHost({ OLLAMA_HOST: "https://ollama.internal/" }), "https://ollama.internal");
});

test("resolveOllamaHost rejects unsafe or ambiguous URLs", () => {
  for (const value of [
    "file:///tmp/ollama.sock",
    "http://user:pass@localhost:11434",
    "http://localhost:11434/api",
    "http://localhost:11434?token=secret",
    "http://localhost:11434/#fragment",
  ]) {
    assert.throws(() => resolveOllamaHost({ OLLAMA_HOST: value }), /HTTP\(S\) origin/);
  }
});

test("parseOllamaModels maps installed models and ignores incomplete entries", () => {
  assert.deepEqual(
    parseOllamaModels({
      models: [
        { name: " llama3.2:latest ", details: { parameter_size: "3.2B" } },
        { name: "qwen2.5-coder:7b" },
        { name: "" },
        {},
      ],
    }),
    [
      {
        id: "llama3.2:latest",
        name: "llama3.2:latest",
        description: "Local model (3.2B)",
      },
      {
        id: "qwen2.5-coder:7b",
        name: "qwen2.5-coder:7b",
        description: "Local model",
      },
    ]
  );
});

test("Ollama model discovery uses the runtime OLLAMA_HOST tags endpoint", async (t) => {
  const original = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = "http://127.0.0.1:22434";
  t.after(() => {
    if (original === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = original;
  });
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request) => {
      assert.equal(String(input), "http://127.0.0.1:22434/api/tags");
      return new Response(
        JSON.stringify({
          models: [{ name: "gemma3:4b", details: { parameter_size: "4.3B" } }],
        }),
        { status: 200 }
      );
    }
  );

  assert.deepEqual(await ollamaProvider.listModels?.(), [
    {
      id: "gemma3:4b",
      name: "gemma3:4b",
      description: "Local model (4.3B)",
    },
  ]);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("Ollama model discovery rejects an unavailable local service", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
  await assert.rejects(ollamaProvider.listModels!(), /status 503/);
});

test("Ollama availability and health are API-first and do not require the CLI", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ version: "0.11.4" }), { status: 200 });
  });

  assert.equal(await ollamaProvider.isAvailable(), true);
  assert.deepEqual(await ollamaProvider.healthCheck(), {
    available: true,
    authenticated: true,
    version: "Ollama 0.11.4",
  });
  assert.deepEqual(calls, [
    `${DEFAULT_OLLAMA_HOST}/api/version`,
    `${DEFAULT_OLLAMA_HOST}/api/version`,
  ]);
});

test("Ollama health reports invalid configuration and unreachable service", async (t) => {
  const original = process.env.OLLAMA_HOST;
  t.after(() => {
    if (original === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = original;
  });
  process.env.OLLAMA_HOST = "ftp://localhost:11434";
  assert.match((await ollamaProvider.healthCheck()).error || "", /HTTP\(S\) origin/);

  process.env.OLLAMA_HOST = DEFAULT_OLLAMA_HOST;
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("fetch failed");
  });
  assert.deepEqual(await ollamaProvider.healthCheck(), {
    available: false,
    authenticated: false,
    error: `Ollama service is not reachable at ${DEFAULT_OLLAMA_HOST}. Start Ollama and retry.`,
  });
});

test("Ollama legacy launch contracts use the selected local model", () => {
  assert.deepEqual(
    ollamaProvider.buildOneShotInvocation?.("Summarize this", "/repo", {
      model: "qwen2.5-coder:7b",
    }).args,
    ["run", "qwen2.5-coder:7b", "Summarize this"]
  );
  const session = ollamaProvider.buildSessionInvocation?.("Review this", "/repo", {
    model: "gemma3:4b",
  });
  assert.deepEqual(session?.args, ["run", "gemma3:4b"]);
  assert.equal(session?.initialPrompt, "Review this");
});
