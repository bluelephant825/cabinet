import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { copilotLocalAdapter } from "./copilot-local";

async function createExecutableScript(source: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-copilot-local-test-"));
  const scriptPath = path.join(dir, "fake-copilot.sh");
  await fs.writeFile(scriptPath, source, "utf8");
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
}

test("copilotLocalAdapter inferenceOnly drops allow-all-tools and adds best-effort denies", async () => {
  const scriptPath = await createExecutableScript(`#!/bin/sh
printf '%s\n' '{"summary":[]}'
`);

  let capturedArgs: string[] = [];
  const result = await copilotLocalAdapter.execute?.({
    runId: "wiki",
    adapterType: "copilot_local",
    config: { command: scriptPath, inferenceOnly: true },
    prompt: "Evidence",
    cwd: process.cwd(),
    onLog: async () => {},
    onMeta: async (meta) => {
      capturedArgs = meta.commandArgs ?? [];
    },
  });

  assert.ok(result);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, '{"summary":[]}');
  assert.equal(capturedArgs.includes("--allow-all-tools"), false);
  assert.ok(capturedArgs.includes("--disable-builtin-mcps"));
  const denials = capturedArgs
    .map((arg, i) => (arg === "--deny-tool" ? capturedArgs[i + 1] : null))
    .filter(Boolean);
  assert.ok(denials.includes("shell(*)"));
  assert.ok(denials.includes("write"));
});
