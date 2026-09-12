import fs from "fs";
import path from "path";
import type { AgentProvider, ProviderStatus } from "../provider-interface";
import {
  checkCliProviderAvailable,
  execCli,
  resolveCliCommand,
} from "../provider-cli";

// Static fallback for `agy models` discovery failures (CLI not installed or
// not signed in). Captured from `agy models` on 1.2.2. Effort is baked into
// the slug (-high/-medium/-low), so no separate effortLevels list.
const ANTIGRAVITY_FALLBACK_MODELS = [
  { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
  { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
  { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
  { id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)" },
  { id: "gemini-3.7-flash-medium", name: "Gemini 3.7 Flash (Medium)" },
  { id: "gemini-3.7-flash-low", name: "Gemini 3.7 Flash (Low)" },
  { id: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash (High)" },
  { id: "gemini-3.6-flash-medium", name: "Gemini 3.6 Flash (Medium)" },
  { id: "gemini-3.6-flash-low", name: "Gemini 3.6 Flash (Low)" },
  { id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)" },
  { id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
  { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },
  { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
] as const;

function fileExists(filePath: string | undefined): boolean {
  if (!filePath) return false;
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function antigravityConfigDir(): string {
  return path.join(process.env.HOME || "", ".gemini", "antigravity-cli");
}

function readSettings(): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(
      path.join(antigravityConfigDir(), "settings.json"),
      "utf8"
    );
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function detectAntigravityAuth(): string | null {
  // API-key mode: GEMINI_API_KEY plus an explicit opt-in in settings.json.
  if (
    process.env.GEMINI_API_KEY &&
    readSettings()?.modelProvider === "gemini"
  ) {
    return "Configured via Gemini API key";
  }

  // OAuth sessions live in the OS keyring; onboarding.json is the on-disk
  // marker that first-run sign-in completed.
  const onboardingPath = path.join(
    antigravityConfigDir(),
    "cache",
    "onboarding.json"
  );
  if (fileExists(onboardingPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(onboardingPath, "utf8"));
      if (parsed && parsed.onboardingComplete === true) {
        return "Signed in with Google (system keyring)";
      }
    } catch {
      // Fall through to unauthenticated.
    }
  }

  return null;
}

/**
 * Pure parser for `agy models` stdout. Lines are `slug<TAB>Display Name`;
 * the leading "Fetching available models..." line and anything without a
 * tab is CLI chrome and gets dropped. Empty output → the static fallback
 * so the picker is never blank.
 */
export function parseAntigravityModels(stdout: string | null | undefined) {
  const out = (stdout || "").trim();
  if (!out) {
    return ANTIGRAVITY_FALLBACK_MODELS.map((m) => ({ ...m }));
  }
  const parsed = out
    .split(/\r?\n/)
    .map((line) => /^(\S+)\t(.+)$/.exec(line.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ id: m[1], name: m[2].trim() }));
  return parsed.length > 0
    ? parsed
    : ANTIGRAVITY_FALLBACK_MODELS.map((m) => ({ ...m }));
}

export const antigravityCliProvider: AgentProvider = {
  id: "antigravity-cli",
  name: "Antigravity CLI",
  type: "cli",
  icon: "antigravity",
  iconAsset: "/providers/antigravity.svg",
  installMessage:
    "Antigravity CLI not found. Install with: curl -fsSL https://antigravity.google/cli/install.sh | bash",
  installSteps: [
    {
      title: "Install Antigravity CLI",
      detail: "Run the following in your terminal:",
      command:
        "curl -fsSL https://antigravity.google/cli/install.sh | bash",
    },
    {
      title: "Log in",
      detail:
        "Start Antigravity and sign in with Google in the browser. For headless or API-key use, set GEMINI_API_KEY and \"modelProvider\": \"gemini\" in ~/.gemini/antigravity-cli/settings.json.",
      command: "agy",
      link: {
        label: "Open Antigravity CLI install guide",
        url: "https://antigravity.google/docs/cli/install/",
      },
    },
    {
      title: "Verify setup",
      detail: "Confirm headless mode works:",
      command:
        "agy -p 'Reply with exactly OK' --print-timeout 60s --disable-slash-commands",
    },
  ],
  detachedPromptLaunchMode: "one-shot",
  models: ANTIGRAVITY_FALLBACK_MODELS.map((m) => ({ ...m, effortLevels: [] })),
  command: "agy",
  commandCandidates: [
    `${process.env.HOME || ""}/.local/bin/agy`,
    "/usr/local/bin/agy",
    "/opt/homebrew/bin/agy",
    "agy",
  ],

  buildArgs(prompt: string, workdir: string): string[] {
    void workdir;
    return [
      "-p",
      prompt,
      "--output-format",
      "text",
      "--dangerously-skip-permissions",
      "--disable-slash-commands",
    ];
  },

  buildOneShotInvocation(prompt: string, workdir: string, opts) {
    const baseArgs = this.buildArgs ? this.buildArgs(prompt, workdir) : [];
    const args = [...baseArgs];
    if (opts?.model) {
      args.push("--model", opts.model);
    }
    return {
      command: this.command || "agy",
      args,
    };
  },

  async listModels() {
    // Same contract as OpenCode: throws on a genuine CLI failure and the
    // models route serves the static fallback with `dynamic:false`.
    const cmd = resolveCliCommand(this);
    const out = await execCli(cmd, ["models"], { timeout: 15_000 });
    return parseAntigravityModels(out);
  },

  async isAvailable(): Promise<boolean> {
    return checkCliProviderAvailable(this);
  },

  async healthCheck(): Promise<ProviderStatus> {
    try {
      const available = await this.isAvailable();
      if (!available) {
        return {
          available: false,
          authenticated: false,
          error: this.installMessage,
        };
      }

      const authSource = detectAntigravityAuth();
      if (authSource) {
        return {
          available: true,
          authenticated: true,
          version: authSource,
        };
      }

      try {
        const cmd = resolveCliCommand(this);
        const version = await execCli(cmd, ["--version"], { timeout: 5000 });
        return {
          available: true,
          authenticated: false,
          error:
            "Antigravity CLI is installed but not signed in. Run: agy",
          version: version ? `Antigravity CLI ${version}` : undefined,
        };
      } catch {
        return {
          available: true,
          authenticated: false,
          error:
            "Antigravity CLI is installed but not signed in. Run: agy",
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
