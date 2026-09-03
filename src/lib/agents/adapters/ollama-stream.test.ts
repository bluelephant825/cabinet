import test from "node:test";
import assert from "node:assert/strict";
import {
  OLLAMA_MAX_EVENT_BYTES,
  OLLAMA_MAX_OUTPUT_CHARS,
  consumeOllamaNdjsonStream,
  createOllamaStreamAccumulator,
  finishOllamaNdjsonStream,
} from "./ollama-stream";

test("Ollama NDJSON parser handles split chunks, final usage, and a final content delta", () => {
  const acc = createOllamaStreamAccumulator();
  assert.equal(
    consumeOllamaNdjsonStream(
      acc,
      '{"message":{"role":"assistant","content":"Hel"},"done":false}\n{"message"'
    ),
    "Hel"
  );
  assert.equal(
    consumeOllamaNdjsonStream(
      acc,
      ':{"role":"assistant","content":"lo"},"done":true,"prompt_eval_count":7,"prompt_eval_cached_count":4,"eval_count":2}'
    ),
    ""
  );
  assert.equal(finishOllamaNdjsonStream(acc), "lo");
  assert.equal(acc.output, "Hello");
  assert.deepEqual(acc.usage, { inputTokens: 7, outputTokens: 2, cachedInputTokens: 4 });
});

test("Ollama NDJSON parser requires valid JSON and exactly one terminal boundary", () => {
  const malformed = createOllamaStreamAccumulator();
  assert.throws(
    () => consumeOllamaNdjsonStream(malformed, "not-json\n"),
    /malformed NDJSON/
  );

  const unfinished = createOllamaStreamAccumulator();
  consumeOllamaNdjsonStream(
    unfinished,
    '{"message":{"role":"assistant","content":"hi"},"done":false}\n'
  );
  assert.throws(() => finishOllamaNdjsonStream(unfinished), /before a final event/);

  const extra = createOllamaStreamAccumulator();
  consumeOllamaNdjsonStream(extra, '{"message":{"content":""},"done":true}\n');
  assert.throws(
    () => consumeOllamaNdjsonStream(extra, '{"message":{"content":"x"},"done":false}\n'),
    /after the final event/
  );
});

test("Ollama NDJSON parser surfaces API errors and validates usage", () => {
  const apiError = createOllamaStreamAccumulator();
  assert.throws(
    () => consumeOllamaNdjsonStream(apiError, '{"error":"model missing","done":true}\n'),
    /Ollama error: model missing/
  );

  const partialUsage = createOllamaStreamAccumulator();
  assert.throws(
    () => consumeOllamaNdjsonStream(
      partialUsage,
      '{"message":{"content":""},"done":true,"eval_count":1}\n'
    ),
    /incomplete token usage/
  );

  for (const cachedCount of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
    const invalidCached = createOllamaStreamAccumulator();
    assert.throws(
      () => consumeOllamaNdjsonStream(
        invalidCached,
        JSON.stringify({
          message: { content: "" },
          done: true,
          prompt_eval_count: 1,
          prompt_eval_cached_count: cachedCount,
          eval_count: 1,
        }) + "\n"
      ),
      /invalid prompt_eval_cached_count/
    );
  }

  const earlyUsage = createOllamaStreamAccumulator();
  assert.throws(
    () => consumeOllamaNdjsonStream(
      earlyUsage,
      '{"message":{"content":"x"},"done":false,"eval_count":1,"prompt_eval_count":1}\n'
    ),
    /before the final event/
  );
});

test("Ollama NDJSON parser enforces event, buffer, and total output bounds", () => {
  const oversizedEvent = createOllamaStreamAccumulator();
  assert.throws(
    () => consumeOllamaNdjsonStream(oversizedEvent, `${"x".repeat(OLLAMA_MAX_EVENT_BYTES + 1)}\n`),
    /1 MiB limit/
  );

  const oversizedBuffer = createOllamaStreamAccumulator();
  assert.throws(
    () => consumeOllamaNdjsonStream(oversizedBuffer, "x".repeat(OLLAMA_MAX_EVENT_BYTES + 1)),
    /buffer exceeded/
  );

  const oversizedOutput = createOllamaStreamAccumulator();
  oversizedOutput.output = "x".repeat(OLLAMA_MAX_OUTPUT_CHARS);
  assert.throws(
    () => consumeOllamaNdjsonStream(
      oversizedOutput,
      '{"message":{"role":"assistant","content":"x"},"done":false}\n'
    ),
    /output limit/
  );
});
