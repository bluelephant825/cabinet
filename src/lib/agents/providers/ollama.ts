import type {
  AgentProvider,
  ProviderModel,
  ProviderStatus,
} from "../provider-interface";
import { checkCliProviderAvailable } from "../provider-cli";
import { readCabinetEnvFile } from "../../runtime/cabinet-env";

export const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";
const MAX_OLLAMA_METADATA_BYTES = 1024 * 1024;
const MAX_OLLAMA_MODELS = 10_000;

interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
    details?: { parameter_size?: string };
  }>;
}

/** Resolve Ollama's HTTP origin at call time so daemon/runtime env changes apply. */
export function resolveOllamaHost(
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const configured = env.OLLAMA_HOST?.trim();
  const candidate = configured || DEFAULT_OLLAMA_HOST;
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(candidate)
    ? candidate
    : `http://${candidate}`;

  let url: URL;
  try {
    url = new URL(withProtocol);
  } catch {
    throw new Error("OLLAMA_HOST must be a valid HTTP(S) origin.");
  }

  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname && url.pathname !== "/")
  ) {
    throw new Error(
      "OLLAMA_HOST must be an HTTP(S) origin without credentials, a path, query, or fragment."
    );
  }

  return url.origin;
}

export function ollamaRuntimeEnv(
  overrides: Readonly<Record<string, string | undefined>> = {}
): Readonly<Record<string, string | undefined>> {
  return { ...readCabinetEnvFile().values, ...process.env, ...overrides };
}

export function ollamaApiUrl(
  path: "/api/version" | "/api/tags" | "/api/chat",
  env?: Readonly<Record<string, string | undefined>>
): string {
  return `${resolveOllamaHost(env ?? ollamaRuntimeEnv())}${path}`;
}

export function parseOllamaModels(data: OllamaTagsResponse): ProviderModel[] {
  if (!data || !Array.isArray(data.models)) return [];
  return data.models
    .filter((model): model is { name: string; details?: { parameter_size?: string } } =>
      Boolean(model && typeof model.name === "string" && model.name.trim())
    )
    .map((model) => ({
      id: model.name.trim(),
      name: model.name.trim(),
      description:
        typeof model.details?.parameter_size === "string" &&
        model.details.parameter_size.trim()
          ? `Local model (${model.details.parameter_size.trim()})`
          : "Local model",
    }));
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

async function readBoundedJson(response: Response, label: string): Promise<unknown> {
  if (!response.body) throw new Error(`${label} returned an empty response.`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      bytes += value.byteLength;
      if (bytes > MAX_OLLAMA_METADATA_BYTES) {
        throw new Error(`${label} response exceeded the 1 MiB limit.`);
      }
      chunks.push(value);
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  const body = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error(`${label} returned malformed JSON.`);
  }
}

async function fetchOllamaVersion(
  env?: Readonly<Record<string, string | undefined>>
): Promise<string | undefined> {
  const response = await fetch(ollamaApiUrl("/api/version", env), {
    signal: AbortSignal.timeout(2_000),
    cache: "no-store",
  });
  if (!response.ok) {
    await cancelResponseBody(response);
    throw new Error(`status ${response.status}`);
  }
  const data = await readBoundedJson(response, "Ollama version");
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Ollama version returned a malformed response.");
  }
  const version = (data as Record<string, unknown>).version;
  if (version !== undefined && typeof version !== "string") {
    throw new Error("Ollama version returned a malformed response.");
  }
  return typeof version === "string" && version.trim() ? version.trim() : undefined;
}

async function fetchOllamaModels(
  env?: Readonly<Record<string, string | undefined>>
): Promise<ProviderModel[]> {
  const response = await fetch(ollamaApiUrl("/api/tags", env), {
    signal: AbortSignal.timeout(3_000),
    cache: "no-store",
  });
  if (!response.ok) {
    await cancelResponseBody(response);
    throw new Error(`Ollama model discovery failed with status ${response.status}.`);
  }
  const data = await readBoundedJson(response, "Ollama model discovery");
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Ollama model discovery returned a malformed response.");
  }
  const models = (data as Record<string, unknown>).models;
  if (!Array.isArray(models) || models.length > MAX_OLLAMA_MODELS) {
    throw new Error("Ollama model discovery returned a malformed response.");
  }
  for (const model of models) {
    if (!model || typeof model !== "object" || Array.isArray(model)) {
      throw new Error("Ollama model discovery returned a malformed response.");
    }
    const candidate = model as Record<string, unknown>;
    if (typeof candidate.name !== "string" || !candidate.name.trim()) {
      throw new Error("Ollama model discovery returned a malformed response.");
    }
    if (candidate.details !== undefined && (
      !candidate.details || typeof candidate.details !== "object" || Array.isArray(candidate.details)
    )) {
      throw new Error("Ollama model discovery returned a malformed response.");
    }
  }
  return parseOllamaModels(data as OllamaTagsResponse);
}

export async function checkOllamaServiceAvailable(
  env?: Readonly<Record<string, string | undefined>>
): Promise<boolean> {
  try {
    await fetchOllamaVersion(env);
    return true;
  } catch {
    return false;
  }
}

export async function listOllamaModels(
  env?: Readonly<Record<string, string | undefined>>
): Promise<ProviderModel[]> {
  return fetchOllamaModels(env);
}

export async function checkOllamaCliAvailable(): Promise<boolean> {
  return checkCliProviderAvailable(ollamaProvider);
}

export const ollamaProvider: AgentProvider = {
  id: "ollama",
  name: "Ollama",
  type: "cli",
  icon: "ollama",
  iconAsset: "/providers/ollama.svg",
  installMessage: "Ollama not found. Install it from ollama.com/download.",
  installSteps: [
    {
      title: "Install Ollama",
      detail: "Download and install Ollama for your operating system:",
      link: {
        label: "Download Ollama",
        url: "https://ollama.com/download",
      },
    },
    {
      title: "Pull a model",
      detail: "Pull a local model to use with Cabinet, for example:",
      command: "ollama pull llama3",
    },
  ],
  detachedPromptLaunchMode: "one-shot",
  command: "ollama",
  commandCandidates: [
    "/usr/local/bin/ollama",
    "/opt/homebrew/bin/ollama",
    "ollama",
  ],

  buildOneShotInvocation(prompt: string, _workdir: string, opts) {
    const model = opts?.model || "llama3";
    return {
      command: this.command || "ollama",
      args: ["run", model, prompt],
    };
  },

  buildSessionInvocation(prompt: string | undefined, _workdir: string, opts) {
    const model = opts?.model || "llama3";
    return {
      command: this.command || "ollama",
      args: ["run", model],
      initialPrompt: prompt,
    };
  },

  async listModels(): Promise<ProviderModel[]> {
    return listOllamaModels();
  },

  // API-first: Cabinet can use Ollama without the optional CLI binary on PATH.
  async isAvailable(): Promise<boolean> {
    return checkOllamaServiceAvailable();
  },

  async healthCheck(): Promise<ProviderStatus> {
    const env = ollamaRuntimeEnv();
    let host: string;
    try {
      host = resolveOllamaHost(env);
    } catch (error) {
      return {
        available: false,
        authenticated: false,
        error: error instanceof Error ? error.message : "Invalid OLLAMA_HOST.",
      };
    }

    try {
      const version = await fetchOllamaVersion(env);
      const models = await fetchOllamaModels(env);
      if (models.length === 0) {
        return {
          available: false,
          authenticated: true,
          version: version ? `Ollama ${version}` : "Ollama running",
          error: "Ollama is reachable but has no installed models. Run `ollama pull <model>` and select it in Cabinet.",
        };
      }
      return {
        available: true,
        authenticated: true,
        version: version ? `Ollama ${version}` : "Ollama running",
      };
    } catch {
      return {
        available: false,
        authenticated: false,
        error: `Ollama service is not ready at ${host}. Start Ollama, verify its model list, and retry.`,
      };
    }
  },
};
