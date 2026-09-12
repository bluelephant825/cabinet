import test from "node:test";
import assert from "node:assert/strict";
import { WikiInferenceModel } from "../server/ingestion/wiki-model";
import { agentAdapterRegistry } from "../src/lib/agents/adapters/registry";
import type { AgentExecutionAdapter } from "../src/lib/agents/adapters/types";

const stubAdapter: AgentExecutionAdapter = {
  type: "grok_local",
  name: "Stub Grok",
  providerId: "grok-cli",
  executionEngine: "structured_cli",
  inference: { hardened: false },
  async execute() {
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      output: '{"summary":[]}',
    };
  },
  async testEnvironment() {
    return { adapterType: "grok_local", status: "pass", checks: [], testedAt: "" };
  },
};

test("wiki status: adapter with inference {hardened:false} is available but warns", async (t) => {
  agentAdapterRegistry.registerExternal(stubAdapter);
  t.after(() => agentAdapterRegistry.unregisterExternal("grok_local"));
  const status = await new WikiInferenceModel({ provider: "grok-cli" }).status();
  assert.equal(status.available, true);
  assert.equal(status.hardened, false);
  assert.match(status.message, /cannot fully disable tools/);
});

test("wiki status: provider without an inference adapter is unavailable", async () => {
  // ollama only has the legacy PTY adapter: no execute, no inference field.
  const status = await new WikiInferenceModel({ provider: "ollama" }).status();
  assert.equal(status.available, false);
  assert.match(status.message, /cannot run restricted Wiki inference/);
});

const hardenedStub: AgentExecutionAdapter = {
  ...stubAdapter,
  type: "antigravity_local",
  name: "Stub Antigravity",
  providerId: "antigravity-cli",
  inference: { hardened: true },
};

test("wiki status: hardened adapter reports hardened with no warning", async (t) => {
  // A stub (not the real claude_local) because provider-management.test.ts
  // races providers.json writes into the shared CABINET_DATA_DIR.
  agentAdapterRegistry.registerExternal(hardenedStub);
  t.after(() => agentAdapterRegistry.unregisterExternal("antigravity_local"));
  const status = await new WikiInferenceModel({ provider: "antigravity-cli" }).status();
  assert.equal(status.available, true);
  assert.equal(status.hardened, true);
  assert.doesNotMatch(status.message, /cannot fully disable tools/);
});
