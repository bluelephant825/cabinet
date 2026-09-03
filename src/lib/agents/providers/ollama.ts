import type {
  AgentProvider,
  ProviderModel,
  ProviderStatus,
} from "../provider-interface";
import { checkCliProviderAvailable } from "../provider-cli";

export const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";

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

export function ollamaApiUrl(
  path: "/api/version" | "/api/tags" | "/api/chat",
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  return `${resolveOllamaHost(env)}${path}`;
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

async function fetchOllamaVersion(): Promise<string | undefined> {
  const response = await fetch(ollamaApiUrl("/api/version"), {
    signal: AbortSignal.timeout(2_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`status ${response.status}`);
  const data = (await response.json()) as { version?: unknown };
  return typeof data.version === "string" && data.version.trim()
    ? data.version.trim()
    : undefined;
}

export async function checkOllamaServiceAvailable(): Promise<boolean> {
  try {
    await fetchOllamaVersion();
    return true;
  } catch {
    return false;
  }
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
    const response = await fetch(ollamaApiUrl("/api/tags"), {
      signal: AbortSignal.timeout(3_000),
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`Ollama model discovery failed with status ${response.status}.`);
    }
    return parseOllamaModels((await response.json()) as OllamaTagsResponse);
  },

  // API-first: Cabinet can use Ollama without the optional CLI binary on PATH.
  async isAvailable(): Promise<boolean> {
    return checkOllamaServiceAvailable();
  },

  async healthCheck(): Promise<ProviderStatus> {
    let host: string;
    try {
      host = resolveOllamaHost();
    } catch (error) {
      return {
        available: false,
        authenticated: false,
        error: error instanceof Error ? error.message : "Invalid OLLAMA_HOST.",
      };
    }

    try {
      const version = await fetchOllamaVersion();
      return {
        available: true,
        authenticated: true,
        version: version ? `Ollama ${version}` : "Ollama running",
      };
    } catch {
      return {
        available: false,
        authenticated: false,
        error: `Ollama service is not reachable at ${host}. Start Ollama and retry.`,
      };
    }
  },
};
