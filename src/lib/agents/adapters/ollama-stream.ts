import type { AdapterUsageSummary } from "./types";

export const OLLAMA_MAX_EVENT_BYTES = 1024 * 1024;
export const OLLAMA_MAX_OUTPUT_CHARS = 4 * 1024 * 1024;
export const OLLAMA_MAX_EVENTS = 100_000;

interface OllamaStreamPayload {
  message?: { role?: unknown; content?: unknown };
  done?: unknown;
  error?: unknown;
  prompt_eval_count?: unknown;
  eval_count?: unknown;
}

export interface OllamaStreamAccumulator {
  buffer: string;
  output: string;
  done: boolean;
  eventCount: number;
  usage?: AdapterUsageSummary;
}

export function createOllamaStreamAccumulator(): OllamaStreamAccumulator {
  return { buffer: "", output: "", done: false, eventCount: 0 };
}

function parseTokenCount(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Ollama final event has an invalid ${field}.`);
  }
  return value as number;
}

function consumeOllamaEvent(
  accumulator: OllamaStreamAccumulator,
  line: string
): string {
  const trimmed = line.trim();
  if (!trimmed) return "";
  if (Buffer.byteLength(trimmed, "utf8") > OLLAMA_MAX_EVENT_BYTES) {
    throw new Error("Ollama stream event exceeded the 1 MiB limit.");
  }
  if (accumulator.done) {
    throw new Error("Ollama stream included an event after the final event.");
  }
  accumulator.eventCount += 1;
  if (accumulator.eventCount > OLLAMA_MAX_EVENTS) {
    throw new Error("Ollama stream exceeded the event limit.");
  }

  let payload: OllamaStreamPayload;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    payload = parsed as OllamaStreamPayload;
  } catch {
    throw new Error("Ollama returned malformed NDJSON.");
  }

  if (typeof payload.error === "string" && payload.error.trim()) {
    throw new Error(`Ollama error: ${payload.error.trim().slice(0, 2_000)}`);
  }
  if (payload.error !== undefined) {
    throw new Error("Ollama returned an invalid error event.");
  }
  if (typeof payload.done !== "boolean") {
    throw new Error("Ollama stream event is missing a boolean done field.");
  }

  let content = "";
  if (payload.message !== undefined) {
    if (
      !payload.message ||
      typeof payload.message !== "object" ||
      typeof payload.message.content !== "string" ||
      (payload.message.role !== undefined && payload.message.role !== "assistant")
    ) {
      throw new Error("Ollama stream event has an invalid assistant message.");
    }
    content = payload.message.content;
  }

  if (accumulator.output.length + content.length > OLLAMA_MAX_OUTPUT_CHARS) {
    throw new Error("Ollama response exceeded the 4 MiB output limit.");
  }
  accumulator.output += content;

  if (payload.done) {
    accumulator.done = true;
    const hasPromptUsage = payload.prompt_eval_count !== undefined;
    const hasOutputUsage = payload.eval_count !== undefined;
    if (hasPromptUsage !== hasOutputUsage) {
      throw new Error("Ollama final event contains incomplete token usage.");
    }
    if (hasPromptUsage) {
      accumulator.usage = {
        inputTokens: parseTokenCount(payload.prompt_eval_count, "prompt_eval_count"),
        outputTokens: parseTokenCount(payload.eval_count, "eval_count"),
      };
    }
  } else if (
    payload.prompt_eval_count !== undefined ||
    payload.eval_count !== undefined
  ) {
    throw new Error("Ollama token usage appeared before the final event.");
  }

  return content;
}

export function consumeOllamaNdjsonStream(
  accumulator: OllamaStreamAccumulator,
  chunk: string
): string {
  accumulator.buffer += chunk;
  const lines = accumulator.buffer.split(/\r?\n/);
  accumulator.buffer = lines.pop() || "";
  if (Buffer.byteLength(accumulator.buffer, "utf8") > OLLAMA_MAX_EVENT_BYTES) {
    throw new Error("Ollama stream buffer exceeded the 1 MiB event limit.");
  }

  let display = "";
  for (const line of lines) display += consumeOllamaEvent(accumulator, line);
  return display;
}

export function finishOllamaNdjsonStream(
  accumulator: OllamaStreamAccumulator
): string {
  let trailing = "";
  if (accumulator.buffer.trim()) {
    const buffered = accumulator.buffer;
    accumulator.buffer = "";
    trailing = consumeOllamaEvent(accumulator, buffered);
  }
  if (!accumulator.done) {
    throw new Error("Ollama stream ended before a final event.");
  }
  return trailing;
}
