import test from "node:test";
import assert from "node:assert/strict";
import { ollamaProvider, parseOllamaModels } from "./ollama";

test("parseOllamaModels maps installed models and ignores incomplete entries", () => {
  assert.deepEqual(
    parseOllamaModels({
      models: [
        { name: "llama3.2:latest", details: { parameter_size: "3.2B" } },
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

test("Ollama model discovery reads the local tags endpoint", async (t) => {
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request) => {
      assert.equal(String(input), "http://127.0.0.1:11434/api/tags");
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

test("Ollama health and launch contracts use the selected local model", async (t) => {
  t.mock.method(ollamaProvider, "isAvailable", async () => true);
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    assert.equal(String(input), "http://127.0.0.1:11434/api/version");
    return new Response(JSON.stringify({ version: "0.11.4" }), { status: 200 });
  });

  assert.deepEqual(await ollamaProvider.healthCheck(), {
    available: true,
    authenticated: true,
    version: "Ollama 0.11.4",
  });
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
