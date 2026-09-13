import { antigravityCliProvider } from "../providers/antigravity-cli";
import { resolveCliCommand } from "../provider-cli";
import { providerStatusToEnvironmentTest } from "./environment";
import {
  consumeAntigravityJsonStream,
  createAntigravityStreamAccumulator,
  flushAntigravityJsonStream,
} from "./antigravity-stream";
import {
  classifyChain,
  classifyCommonError,
} from "./error-classification";
import type { AgentExecutionAdapter } from "./types";
import { agentRunEnv, getAdapterRuntimePath, runChildProcess } from "./utils";
import { readEffortConfig, readStringConfig } from "./_shared/cli-args";

function firstNonEmptyLine(text: string): string | null {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) || null
  );
}

function buildAntigravityArgs(
  config: Record<string, unknown>,
  prompt: string,
  timeoutMs: number | undefined
): string[] {
  const timeoutSeconds =
    Math.ceil((timeoutMs ?? 30 * 60_000) / 1000) + 5;
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--disable-slash-commands",
    "--print-timeout",
    `${timeoutSeconds}s`,
    ...(config.inferenceOnly === true
      ? ["--sandbox"]
      : ["--dangerously-skip-permissions"]),
  ];

  const model = readStringConfig(config, "model");
  if (model) {
    args.push("--model", model);
  }

  const effort = readEffortConfig(config);
  if (effort) {
    args.push("--effort", effort);
  }

  return args;
}

export const antigravityLocalAdapter: AgentExecutionAdapter = {
  type: "antigravity_local",
  name: "Antigravity Local",
  description:
    "Structured Antigravity CLI execution using stream-json output for live transcript updates and detached runs.",
  providerId: antigravityCliProvider.id,
  executionEngine: "structured_cli",
  supportsDetachedRuns: true,
  supportsSessionResume: false,
  models: antigravityCliProvider.models,
  listModels: () => antigravityCliProvider.listModels!(),
  inference: { hardened: true },
  classifyError(stderr, exitCode) {
    return classifyChain(stderr, exitCode, [
      (s, c) =>
        classifyCommonError(s, c, {
          providerDisplayName: "Antigravity CLI",
          cliCommand: "agy",
        }),
    ]);
  },
  async testEnvironment() {
    return providerStatusToEnvironmentTest(
      "antigravity_local",
      await antigravityCliProvider.healthCheck(),
      antigravityCliProvider.installMessage
    );
  },
  async execute(ctx) {
    const command =
      readStringConfig(ctx.config, "command") ||
      resolveCliCommand(antigravityCliProvider);
    const inferenceOnly = ctx.config.inferenceOnly === true;
    const args = buildAntigravityArgs(ctx.config, ctx.prompt, ctx.timeoutMs);
    const stdoutAccumulator = createAntigravityStreamAccumulator();

    await ctx.onMeta?.({
      adapterType: ctx.adapterType,
      command,
      commandArgs: args,
      cwd: ctx.cwd,
      env: {
        PATH: getAdapterRuntimePath(),
      },
    });

    const result = await runChildProcess(command, args, {
      cwd: ctx.cwd,
      env: agentRunEnv(ctx),
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      onSpawn: ctx.onSpawn,
      onStdout: (chunk) => {
        const display = consumeAntigravityJsonStream(stdoutAccumulator, chunk);
        if (!display) return;
        void ctx.onLog("stdout", display);
      },
      onStderr: (chunk) => {
        void ctx.onLog("stderr", chunk);
      },
    });

    const trailingStdout = flushAntigravityJsonStream(stdoutAccumulator);
    if (trailingStdout) {
      await ctx.onLog("stdout", trailingStdout);
    }

    const output = (
      inferenceOnly
        ? stdoutAccumulator.lastAssistantMessage
        : stdoutAccumulator.display
    )?.trim() || null;

    let exitCode = result.exitCode;
    let synthesizedError: string | null = null;
    if (result.exitCode === 0) {
      if (stdoutAccumulator.status && stdoutAccumulator.status !== "SUCCESS") {
        exitCode = 1;
      } else if (
        inferenceOnly &&
        (stdoutAccumulator.toolSteps > 0 ||
          stdoutAccumulator.deniedActions.length > 0)
      ) {
        exitCode = 1;
        synthesizedError =
          "Antigravity attempted tool use during restricted Wiki inference";
      } else if (inferenceOnly && !stdoutAccumulator.lastAssistantMessage) {
        exitCode = 1;
        synthesizedError =
          "Antigravity returned no response during restricted Wiki inference";
      }
    }

    const filteredStderr = result.stderr.trim();
    const summaryLine =
      firstNonEmptyLine(
        stdoutAccumulator.lastAssistantMessage || output || ""
      )?.slice(0, 300) || null;

    return {
      exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      errorMessage:
        exitCode === 0
          ? null
          : synthesizedError ||
            stdoutAccumulator.error ||
            filteredStderr ||
            result.stdout.trim() ||
            output ||
            "Antigravity local execution failed.",
      usage: stdoutAccumulator.usage,
      sessionId: stdoutAccumulator.sessionId,
      provider: antigravityCliProvider.id,
      model:
        readStringConfig(ctx.config, "model") ||
        stdoutAccumulator.model ||
        null,
      billingType: "unknown",
      summary: summaryLine,
      output,
    };
  },
};
