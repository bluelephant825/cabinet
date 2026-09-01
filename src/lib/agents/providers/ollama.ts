import type {
  AgentProvider,
  ProviderModel,
  ProviderStatus,
} from "../provider-interface";
import { checkCliProviderAvailable } from "../provider-cli";

const OLLAMA_API_URL = "http://127.0.0.1:11434";

interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
    details?: { parameter_size?: string };
  }>;
}

export function parseOllamaModels(data: OllamaTagsResponse): ProviderModel[] {
  return (data.models || [])
    .filter((model): model is { name: string; details?: { parameter_size?: string } } =>
      Boolean(model.name?.trim())
    )
    .map((model) => ({
      id: model.name,
      name: model.name,
      description: model.details?.parameter_size
        ? `Local model (${model.details.parameter_size})`
        : "Local model",
    }));
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
    const response = await fetch(`${OLLAMA_API_URL}/api/tags`, {
      signal: AbortSignal.timeout(3_000),
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`Ollama model discovery failed with status ${response.status}`);
    }
    return parseOllamaModels((await response.json()) as OllamaTagsResponse);
  },

  async isAvailable(): Promise<boolean> {
    return checkCliProviderAvailable(this);
  },

  async healthCheck(): Promise<ProviderStatus> {
    try {
      if (!(await this.isAvailable())) {
        return {
          available: false,
          authenticated: false,
          error: this.installMessage,
        };
      }

      try {
        const response = await fetch(`${OLLAMA_API_URL}/api/version`, {
          signal: AbortSignal.timeout(2_000),
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`status ${response.status}`);
        const data = (await response.json()) as { version?: string };
        return {
          available: true,
          authenticated: true,
          version: data.version ? `Ollama ${data.version}` : "Ollama running",
        };
      } catch {
        return {
          available: true,
          authenticated: false,
          error: "Ollama is installed but its local service is not running.",
        };
      }
    } catch (error) {
      return {
        available: false,
        authenticated: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  },
};
