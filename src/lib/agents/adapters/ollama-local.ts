import { readStringConfig } from "./_shared/cli-args";
import {
  classifyChain,
  classifyCommonError,
} from "./error-classification";
import {
  createOllamaStreamAccumulator,
  consumeOllamaNdjsonStream,
  finishOllamaNdjsonStream,
} from "./ollama-stream";
import type {
  AdapterExecutionResult,
  AdapterSessionCodec,
  AgentExecutionAdapter,
} from "./types";
import {
  ollamaApiUrl,
  ollamaProvider,
  ollamaRuntimeEnv,
  resolveOllamaHost,
} from "../providers/ollama";

const MAX_MODEL_CHARS = 256;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_HISTORY_MESSAGES = 40;
const MAX_HISTORY_CONTENT_CHARS = 32 * 1024;
const MAX_HISTORY_TOTAL_CHARS = 128 * 1024;
const MAX_ERROR_BODY_CHARS = 8 * 1024;

type OllamaChatRole = "user" | "assistant";
interface OllamaChatMessage {
  role: OllamaChatRole;
  content: string;
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function parseModel(raw: unknown): string | null {
  return typeof raw === "string" &&
    raw.length <= MAX_MODEL_CHARS &&
    raw === raw.trim() &&
    raw.length > 0 &&
    !/[\u0000-\u001f\u007f]/.test(raw)
    ? raw
    : null;
}

function parseHistory(raw: unknown): OllamaChatMessage[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_HISTORY_MESSAGES) return null;
  let total = 0;
  const messages: OllamaChatMessage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    if (!hasExactKeys(record, ["content", "role"])) return null;
    const { role, content } = record;
    if (
      (role !== "user" && role !== "assistant") ||
      typeof content !== "string" ||
      !content.trim() ||
      content.length > MAX_HISTORY_CONTENT_CHARS
    ) {
      return null;
    }
    total += content.length;
    if (total > MAX_HISTORY_TOTAL_CHARS) return null;
    messages.push({ role, content });
  }
  return messages;
}

function boundedHistory(messages: OllamaChatMessage[]): OllamaChatMessage[] {
  const bounded = messages.map((message) => ({
    role: message.role,
    content: message.content.slice(-MAX_HISTORY_CONTENT_CHARS),
  }));
  let total = bounded.reduce((sum, message) => sum + message.content.length, 0);
  while (
    bounded.length > MAX_HISTORY_MESSAGES ||
    total > MAX_HISTORY_TOTAL_CHARS
  ) {
    const removed = bounded.shift();
    total -= removed?.content.length || 0;
  }
  return bounded;
}

function parseSessionParams(raw: unknown): { model: string; messages: OllamaChatMessage[] } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (!hasExactKeys(record, ["messages", "model"])) return null;
  const model = parseModel(record.model);
  const messages = parseHistory(record.messages);
  return model && messages ? { model, messages } : null;
}

export const ollamaSessionCodec: AdapterSessionCodec = {
  deserialize: parseSessionParams,
  serialize: parseSessionParams,
  getDisplayId(params) {
    const parsed = parseSessionParams(params);
    return parsed
      ? `Ollama · ${parsed.model} · ${parsed.messages.length} messages`
      : null;
  },
};

function historyFromParams(
  params: Record<string, unknown> | null | undefined,
  selectedModel: string
): OllamaChatMessage[] {
  const parsed = parseSessionParams(params);
  return parsed?.model === selectedModel ? parsed.messages : [];
}

async function readBoundedErrorBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let completed = false;
  try {
    while (bytes <= MAX_ERROR_BODY_CHARS) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        text += decoder.decode();
        break;
      }
      const remaining = MAX_ERROR_BODY_CHARS - bytes;
      if (value.byteLength > remaining) {
        text += decoder.decode(value.subarray(0, remaining));
        break;
      }
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return text.slice(0, MAX_ERROR_BODY_CHARS).trim();
}

function httpErrorMessage(status: number, body: string): string {
  let detail = body;
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    detail = typeof parsed.error === "string" ? parsed.error : body;
  } catch {}
  detail = detail.trim().slice(0, 2_000);

  if (status === 404 && /model|pull/i.test(detail)) {
    return `Ollama model is unavailable. ${detail}`.trim();
  }
  if (status === 404) {
    return "Ollama's /api/chat endpoint was not found. Update Ollama and retry.";
  }
  if (status === 400) {
    return `Ollama rejected the chat request${detail ? `: ${detail}` : "."}`;
  }
  if (status === 429) return "Ollama is busy or rate limited. Retry shortly.";
  if (status >= 500) {
    return `Ollama service failed with status ${status}${detail ? `: ${detail}` : "."}`;
  }
  return `Ollama chat request failed with status ${status}${detail ? `: ${detail}` : "."}`;
}

function failedResult(input: {
  message: string;
  model: string | null;
  timedOut?: boolean;
  errorCode?: string;
}): AdapterExecutionResult {
  return {
    exitCode: 1,
    signal: null,
    timedOut: input.timedOut ?? false,
    errorMessage: input.message,
    errorCode: input.errorCode ?? "ollama_request_failed",
    provider: ollamaProvider.id,
    model: input.model,
    billingType: "unknown",
    output: null,
  };
}

export const ollamaLocalAdapter: AgentExecutionAdapter = {
  type: "ollama_local",
  name: "Ollama Local",
  description:
    "Native local Ollama execution over the streaming /api/chat endpoint, with bounded conversation history.",
  providerId: ollamaProvider.id,
  executionEngine: "http",
  supportsDetachedRuns: true,
  supportsSessionResume: true,
  sessionCodec: ollamaSessionCodec,
  async listModels() {
    return (await ollamaProvider.listModels?.()) || [];
  },
  classifyError(stderr, exitCode) {
    return classifyChain(stderr, exitCode, [
      (text) =>
        /model.*(?:not found|unavailable)|pull (?:it|the model)/i.test(text)
          ? {
              kind: "model_unavailable",
              hint: "The selected Ollama model is not installed. Pull it in Ollama or choose an installed model.",
            }
          : null,
      (text, code) =>
        classifyCommonError(text, code, {
          providerDisplayName: "Ollama",
          cliCommand: "Ollama HTTP API",
        }),
    ]);
  },
  async testEnvironment(ctx) {
    const env = ollamaRuntimeEnv(ctx?.env);
    let host: string;
    try {
      host = resolveOllamaHost(env);
    } catch (error) {
      return {
        adapterType: "ollama_local",
        status: "fail",
        checks: [{
          code: "ollama_host",
          level: "error",
          message: error instanceof Error ? error.message : "Invalid OLLAMA_HOST.",
        }],
        testedAt: new Date().toISOString(),
      };
    }
    try {
      const response = await fetch(`${host}/api/version`, {
        signal: AbortSignal.timeout(2_000),
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      return {
        adapterType: "ollama_local",
        status: "pass",
        checks: [{
          code: "ollama_service",
          level: "info",
          message: "Ollama HTTP service is reachable.",
          detail: host,
        }],
        testedAt: new Date().toISOString(),
      };
    } catch {
      return {
        adapterType: "ollama_local",
        status: "fail",
        checks: [{
          code: "ollama_service",
          level: "error",
          message: `Ollama service is not reachable at ${host}.`,
          hint: "Start Ollama and verify OLLAMA_HOST, then retry.",
        }],
        testedAt: new Date().toISOString(),
      };
    }
  },
  async execute(ctx) {
    const configuredModel = readStringConfig(ctx.config, "model");
    const model = parseModel(configuredModel);
    if (!model) {
      return failedResult({
        message: "Ollama model is unavailable because no valid model is selected. Install one with `ollama pull <model>`, then select that installed model in Cabinet.",
        model: null,
        errorCode: "model_unavailable",
      });
    }
    let endpoint: string;
    try {
      endpoint = ollamaApiUrl("/api/chat");
    } catch (error) {
      return failedResult({
        message: error instanceof Error ? error.message : "Invalid OLLAMA_HOST.",
        model,
        errorCode: "invalid_ollama_host",
      });
    }

    const priorMessages = historyFromParams(ctx.sessionParams, model);
    const requestMessages = [
      ...priorMessages,
      { role: "user" as const, content: ctx.prompt },
    ];
    const controller = new AbortController();
    let timedOut = false;
    const timeoutMs =
      typeof ctx.timeoutMs === "number" && ctx.timeoutMs > 0
        ? ctx.timeoutMs
        : DEFAULT_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("Ollama request timed out."));
    }, timeoutMs);
    const cancel = () => controller.abort(ctx.signal?.reason);
    if (ctx.signal?.aborted) cancel();
    else ctx.signal?.addEventListener("abort", cancel, { once: true });

    try {
      await ctx.onMeta?.({
        adapterType: ctx.adapterType,
        command: "POST /api/chat",
        commandArgs: [model],
        cwd: ctx.cwd,
        env: { OLLAMA_HOST: new URL(endpoint).origin },
      });

      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: requestMessages, stream: true }),
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok) {
        const body = await readBoundedErrorBody(response);
        return failedResult({ message: httpErrorMessage(response.status, body), model });
      }
      if (!response.body) {
        return failedResult({ message: "Ollama returned an empty response stream.", model });
      }

      const accumulator = createOllamaStreamAccumulator();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let streamCompleted = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            streamCompleted = true;
            break;
          }
          const display = consumeOllamaNdjsonStream(
            accumulator,
            decoder.decode(value, { stream: true })
          );
          if (display) await ctx.onLog("stdout", display);
        }
        const decodedTail = decoder.decode();
        if (decodedTail) {
          const display = consumeOllamaNdjsonStream(accumulator, decodedTail);
          if (display) await ctx.onLog("stdout", display);
        }
        const trailing = finishOllamaNdjsonStream(accumulator);
        if (trailing) await ctx.onLog("stdout", trailing);
      } finally {
        if (!streamCompleted) await reader.cancel().catch(() => {});
        reader.releaseLock();
      }

      const output = accumulator.output.trim() || null;
      if (!output) {
        return failedResult({ message: "Ollama completed without an assistant response.", model });
      }
      const messages = boundedHistory([
        ...requestMessages,
        { role: "assistant", content: accumulator.output },
      ]);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        usage: accumulator.usage,
        sessionId: null,
        sessionParams: { model, messages },
        sessionDisplayId: `Ollama · ${model} · ${messages.length} messages`,
        provider: ollamaProvider.id,
        model,
        billingType: "unknown",
        summary: output.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 300) || null,
        output,
      };
    } catch (error) {
      if (timedOut) {
        return failedResult({
          message: `Ollama request timed out after ${timeoutMs} ms.`,
          model,
          timedOut: true,
          errorCode: "ollama_timeout",
        });
      }
      if (ctx.signal?.aborted) {
        return failedResult({
          message: "Ollama request was cancelled.",
          model,
          errorCode: "ollama_cancelled",
        });
      }
      return failedResult({
        message: error instanceof Error
          ? `Ollama request failed: ${error.message}`
          : "Ollama request failed.",
        model,
      });
    } finally {
      clearTimeout(timeout);
      ctx.signal?.removeEventListener("abort", cancel);
    }
  },
};
