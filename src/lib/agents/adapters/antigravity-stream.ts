import type { AdapterUsageSummary } from "./types";

interface AntigravityInitPayload {
  event?: string;
  conversation_id?: string;
  init?: {
    model?: string;
  };
}

interface AntigravityStepUpdatePayload {
  event?: string;
  step_update?: {
    step_index?: number;
    step_type?: string;
    state?: string;
    text_delta?: string;
    tool_name?: string;
    tool_info?: {
      name?: string;
      parameters?: {
        CommandLine?: string;
      };
      error?: {
        message?: string;
      };
    };
    usage?: AntigravityUsage;
  };
}

interface AntigravityUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
}

interface AntigravityResultPayload {
  event?: string;
  result?: {
    status?: string;
    response?: string;
    error?: string;
    usage?: AntigravityUsage;
    denied_actions?: Array<{ action?: string }>;
  };
}

export interface AntigravityStreamAccumulator {
  buffer: string;
  display: string;
  sessionId?: string | null;
  model?: string | null;
  usage?: AdapterUsageSummary;
  lastAssistantMessage?: string | null;
  currentAssistantMessage: string;
  toolSteps: number;
  toolStepIndexes: Set<number>;
  deniedActions: string[];
  status?: string | null;
  error?: string | null;
}

function appendDisplay(
  accumulator: AntigravityStreamAccumulator,
  text: string
): string {
  if (!text) return "";
  accumulator.display = `${accumulator.display}${text}`;
  return text;
}

function commitAssistantMessage(
  accumulator: AntigravityStreamAccumulator
): void {
  const trimmed = accumulator.currentAssistantMessage.trim();
  if (trimmed) {
    accumulator.lastAssistantMessage = trimmed;
  }
  accumulator.currentAssistantMessage = "";
}

function parseUsage(
  payload: AntigravityUsage | undefined
): AdapterUsageSummary | undefined {
  if (
    !payload ||
    typeof payload.input_tokens !== "number" ||
    typeof payload.output_tokens !== "number"
  ) {
    return undefined;
  }

  return {
    inputTokens: payload.input_tokens,
    outputTokens: payload.output_tokens,
    ...(typeof payload.cache_read_tokens === "number" &&
    payload.cache_read_tokens > 0
      ? { cachedInputTokens: payload.cache_read_tokens }
      : {}),
  };
}

function consumeAntigravityEvent(
  accumulator: AntigravityStreamAccumulator,
  line: string
): string {
  const trimmed = line.trim();
  if (!trimmed) return "";

  try {
    const payload = JSON.parse(trimmed) as { event?: string };

    if (payload.event === "init") {
      const initPayload = payload as AntigravityInitPayload;
      if (typeof initPayload.conversation_id === "string") {
        accumulator.sessionId = initPayload.conversation_id;
      }
      if (typeof initPayload.init?.model === "string") {
        accumulator.model = initPayload.init.model;
      }
      return "";
    }

    if (payload.event === "step_update") {
      const step = (payload as AntigravityStepUpdatePayload).step_update;
      if (!step) return "";

      if (step.step_type === "agent_response") {
        if (typeof step.text_delta === "string") {
          accumulator.currentAssistantMessage = `${accumulator.currentAssistantMessage}${step.text_delta}`;
          return appendDisplay(accumulator, step.text_delta);
        }
        return "";
      }

      if (step.step_type === "tool") {
        // Count a tool step once per step_index regardless of state; a fast
        // tool step can arrive as a lone DONE without a preceding ACTIVE.
        const index =
          typeof step.step_index === "number" ? step.step_index : null;
        const firstSeen =
          index === null || !accumulator.toolStepIndexes.has(index);
        let display = "";
        if (firstSeen) {
          if (index !== null) accumulator.toolStepIndexes.add(index);
          commitAssistantMessage(accumulator);
          accumulator.toolSteps += 1;
          const command = step.tool_info?.parameters?.CommandLine;
          if (
            step.tool_name === "run_command" &&
            typeof command === "string"
          ) {
            const prefix =
              accumulator.display && !accumulator.display.endsWith("\n")
                ? "\n"
                : "";
            display += appendDisplay(
              accumulator,
              `${prefix}$ ${command.trim()}\n`
            );
          }
        }
        if (step.state === "ERROR") {
          const message = step.tool_info?.error?.message;
          if (message) {
            const prefix =
              accumulator.display && !accumulator.display.endsWith("\n")
                ? "\n"
                : "";
            display += appendDisplay(
              accumulator,
              `${prefix}[tool failed: ${message}]\n`
            );
          }
        }
        return display;
      }

      // user_input, checkpoint, unknown step types: no display output.
      const usage = parseUsage(step.usage);
      if (usage) accumulator.usage = usage;
      return "";
    }

    if (payload.event === "result") {
      const result = (payload as AntigravityResultPayload).result;
      if (!result) return "";
      commitAssistantMessage(accumulator);
      if (typeof result.response === "string" && result.response.trim()) {
        accumulator.lastAssistantMessage = result.response.trim();
      }
      const usage = parseUsage(result.usage);
      if (usage) {
        accumulator.usage = usage;
      }
      accumulator.status = result.status ?? null;
      accumulator.error =
        typeof result.error === "string" ? result.error : null;
      if (Array.isArray(result.denied_actions)) {
        accumulator.deniedActions = result.denied_actions
          .map((a) => a?.action)
          .filter((a): a is string => typeof a === "string");
      }
      return "";
    }
  } catch {
    return "";
  }

  return "";
}

export function createAntigravityStreamAccumulator(): AntigravityStreamAccumulator {
  return {
    buffer: "",
    display: "",
    sessionId: null,
    model: null,
    usage: undefined,
    lastAssistantMessage: null,
    currentAssistantMessage: "",
    toolSteps: 0,
    toolStepIndexes: new Set<number>(),
    deniedActions: [],
    status: null,
    error: null,
  };
}

export function consumeAntigravityJsonStream(
  accumulator: AntigravityStreamAccumulator,
  chunk: string
): string {
  accumulator.buffer = `${accumulator.buffer}${chunk}`;
  const lines = accumulator.buffer.split(/\r?\n/);
  accumulator.buffer = lines.pop() || "";

  let display = "";
  for (const line of lines) {
    display += consumeAntigravityEvent(accumulator, line);
  }

  return display;
}

export function flushAntigravityJsonStream(
  accumulator: AntigravityStreamAccumulator
): string {
  if (!accumulator.buffer) {
    commitAssistantMessage(accumulator);
    return "";
  }

  const buffered = accumulator.buffer;
  accumulator.buffer = "";
  return consumeAntigravityEvent(accumulator, buffered);
}
