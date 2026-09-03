import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_OLLAMA_HOST,
  ollamaProvider,
  ollamaRuntimeEnv,
  parseOllamaModels,
  resolveOllamaHost,
} from "./ollama";

const inheritedOllamaHost = process.env.OLLAMA_HOST;
process.env.OLLAMA_HOST = "";
after(() => {
  if (inheritedOllamaHost === undefined) delete process.env.OLLAMA_HOST;
  else process.env.OLLAMA_HOST = inheritedOllamaHost;
});

test("resolveOllamaHost applies the default, accepts bare hosts, and normalizes origins", () => {
  assert.equal(resolveOllamaHost({}), DEFAULT_OLLAMA_HOST);
  assert.equal(resolveOllamaHost({ OLLAMA_HOST: "localhost:11435" }), "http://localhost:11435");
  assert.equal(resolveOllamaHost({ OLLAMA_HOST: "https://ollama.internal/" }), "https://ollama.internal");
});

test("ollamaRuntimeEnv applies explicit runtime overrides without accepting request config", () => {
  assert.equal(
    ollamaRuntimeEnv({ OLLAMA_HOST: "runtime.test:11434" }).OLLAMA_HOST,
    "runtime.test:11434"
  );
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
    const url = String(input);
    calls.push(url);
    return new Response(JSON.stringify(
      url.endsWith("/api/tags")
        ? { models: [{ name: "llama3" }] }
        : { version: "0.11.4" }
    ), { status: 200 });
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
    `${DEFAULT_OLLAMA_HOST}/api/tags`,
  ]);
});

test("Ollama health uses one merged runtime env for its displayed host and requests", async (t) => {
  const original = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = "health.test:11434";
  t.after(() => {
    if (original === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = original;
  });
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/api/version")) {
      process.env.OLLAMA_HOST = "changed.test:11434";
      return new Response(JSON.stringify({ version: "0.11.4" }));
    }
    throw new TypeError("fetch failed");
  });

  assert.deepEqual(await ollamaProvider.healthCheck(), {
    available: false,
    authenticated: false,
    error: "Ollama service is not ready at http://health.test:11434. Start Ollama, verify its model list, and retry.",
  });
  assert.deepEqual(calls, [
    "http://health.test:11434/api/version",
    "http://health.test:11434/api/tags",
  ]);
});

test("Ollama health reports a reachable service with no models as not ready", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) =>
    new Response(JSON.stringify(
      String(input).endsWith("/api/tags") ? { models: [] } : { version: "0.11.4" }
    ))
  );
  assert.deepEqual(await ollamaProvider.healthCheck(), {
    available: false,
    authenticated: true,
    version: "Ollama 0.11.4",
    error: "Ollama is reachable but has no installed models. Run `ollama pull <model>` and select it in Cabinet.",
  });
});

test("Ollama metadata readers reject malformed and oversized responses and cancel readers", async (t) => {
  let cancelled = 0;
  const encoder = new TextEncoder();
  const fetchMock = t.mock.method(globalThis, "fetch", async () =>
    new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("x".repeat(1024 * 1024 + 1)));
      },
      cancel() {
        cancelled += 1;
      },
    }))
  );
  await assert.rejects(ollamaProvider.listModels!(), /1 MiB limit/);
  assert.equal(cancelled, 1);

  fetchMock.mock.mockImplementation(async () => new Response("not-json"));
  await assert.rejects(ollamaProvider.listModels!(), /malformed JSON/);

  fetchMock.mock.mockImplementation(async () => new Response(JSON.stringify({ models: "bad" })));
  await assert.rejects(ollamaProvider.listModels!(), /malformed response/);
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
    error: `Ollama service is not ready at ${DEFAULT_OLLAMA_HOST}. Start Ollama, verify its model list, and retry.`,
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
