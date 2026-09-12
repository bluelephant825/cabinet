import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { antigravityLocalAdapter } from "./antigravity-local";

async function createExecutableScript(source: string): Promise<string> {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "cabinet-antigravity-local-test-")
  );
  const scriptPath = path.join(dir, "fake-agy.sh");
  await fs.writeFile(scriptPath, source, "utf8");
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
}

test("antigravityLocalAdapter executes a structured stream-json run", async () => {
  const scriptPath = await createExecutableScript(`#!/bin/sh
skip=0
model=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dangerously-skip-permissions) skip=1; shift ;;
    --sandbox) exit 4 ;;
    --print-timeout) timeout_arg="$2"; shift 2 ;;
    --model) model="$2"; shift 2 ;;
    *) shift ;;
  esac
done
test "$skip" = 1 || exit 5
test -n "$timeout_arg" || exit 6
printf '%s\\n' \\
  '{"event":"init","conversation_id":"conv-123","init":{"cwd":"/tmp/x","tools":["run_command"],"permission_mode":"skip","model":"'$model'"}}' \\
  '{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"OK"}}' \\
  '{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"\\n","usage":{"input_tokens":14154,"output_tokens":26,"thinking_tokens":25,"cache_read_tokens":0,"total_tokens":14180}}}' \\
  '{"event":"result","result":{"conversation_id":"conv-123","status":"SUCCESS","response":"OK\\n","duration_seconds":1.2,"num_turns":1,"usage":{"input_tokens":14154,"output_tokens":26,"thinking_tokens":25,"cache_read_tokens":0,"total_tokens":14180}}}'
`);

  const result = await antigravityLocalAdapter.execute?.({
    runId: "run-1",
    adapterType: "antigravity_local",
    config: { command: scriptPath, model: "gemini-3.8-flash-medium" },
    prompt: "Reply with exactly OK",
    cwd: process.cwd(),
    timeoutMs: 60000,
    onLog: async () => {},
  });

  assert.ok(result);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, "OK");
  assert.equal(result.provider, "antigravity-cli");
  assert.equal(result.model, "gemini-3.8-flash-medium");
  assert.equal(result.billingType, "unknown");
  assert.equal(result.sessionId, "conv-123");
  assert.deepEqual(result.usage, {
    inputTokens: 14154,
    outputTokens: 26,
  });
});

test("antigravityLocalAdapter inferenceOnly runs sandboxed without skip-permissions", async () => {
  const scriptPath = await createExecutableScript(`#!/bin/sh
sandbox=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dangerously-skip-permissions) exit 4 ;;
    --sandbox) sandbox=1; shift ;;
    *) shift ;;
  esac
done
test "$sandbox" = 1 || exit 5
printf '%s\\n' \\
  '{"event":"init","conversation_id":"conv-wiki","init":{"cwd":"/tmp/x","tools":[],"permission_mode":"request-review"}}' \\
  '{"event":"result","result":{"conversation_id":"conv-wiki","status":"SUCCESS","response":"{\\"summary\\":[]}","usage":{"input_tokens":10,"output_tokens":5}}}'
`);

  const result = await antigravityLocalAdapter.execute?.({
    runId: "wiki",
    adapterType: "antigravity_local",
    config: { command: scriptPath, inferenceOnly: true },
    prompt: "Evidence",
    cwd: process.cwd(),
    onLog: async () => {},
  });

  assert.ok(result);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, '{"summary":[]}');
});

test("antigravityLocalAdapter inferenceOnly fails closed on tool use and denied actions", async () => {
  const scriptPath = await createExecutableScript(`#!/bin/sh
printf '%s\\n' \\
  '{"event":"init","conversation_id":"conv-denied","init":{"cwd":"/tmp/x","tools":["run_command"],"permission_mode":"request-review"}}' \\
  '{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"pwd"}}}}' \\
  '{"event":"step_update","step_update":{"step_index":2,"state":"ERROR","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"pwd"},"error":{"type":"TOOL_ERROR","message":"permission check failed"}}}}' \\
  '{"event":"result","result":{"conversation_id":"conv-denied","status":"SUCCESS","response":"","usage":{"input_tokens":10,"output_tokens":0},"denied_actions":[{"action":"command","display_name":"RunCommand"}]}}'
printf '%s\\n' 'jetski: no output produced - a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.' >&2
`);

  const result = await antigravityLocalAdapter.execute?.({
    runId: "wiki-denied",
    adapterType: "antigravity_local",
    config: { command: scriptPath, inferenceOnly: true },
    prompt: "Run the shell command pwd and reply DONE",
    cwd: process.cwd(),
    onLog: async () => {},
  });

  assert.ok(result);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.errorMessage ?? "", /attempted tool use/);
});

test("antigravityLocalAdapter inferenceOnly counts a lone DONE tool step as tool use", async () => {
  const scriptPath = await createExecutableScript(`#!/bin/sh
printf '%s\\n' \\
  '{"event":"init","conversation_id":"conv-fast","init":{"cwd":"/tmp/x","tools":["write_to_file"],"permission_mode":"request-review"}}' \\
  '{"event":"step_update","step_update":{"step_index":3,"state":"DONE","step_type":"tool","tool_name":"write_to_file","tool_info":{"name":"write_to_file","parameters":{}}}}' \\
  '{"event":"result","result":{"conversation_id":"conv-fast","status":"SUCCESS","response":"DONE","usage":{"input_tokens":10,"output_tokens":2}}}'
`);

  const result = await antigravityLocalAdapter.execute?.({
    runId: "wiki-fast-tool",
    adapterType: "antigravity_local",
    config: { command: scriptPath, inferenceOnly: true },
    prompt: "Evidence",
    cwd: process.cwd(),
    onLog: async () => {},
  });

  assert.ok(result);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.errorMessage ?? "", /attempted tool use/);
});

test("antigravityLocalAdapter synthesizes failure when the result envelope reports ERROR", async () => {
  const scriptPath = await createExecutableScript(`#!/bin/sh
printf '%s\\n' \\
  '{"event":"init","conversation_id":"conv-err","init":{"cwd":"/tmp/x","tools":[],"permission_mode":"skip"}}' \\
  '{"event":"result","result":{"conversation_id":"conv-err","status":"ERROR","error":"model exploded","response":"","usage":{"input_tokens":3,"output_tokens":0}}}'
`);

  const result = await antigravityLocalAdapter.execute?.({
    runId: "err",
    adapterType: "antigravity_local",
    config: { command: scriptPath },
    prompt: "Hi",
    cwd: process.cwd(),
    onLog: async () => {},
  });

  assert.ok(result);
  assert.equal(result.exitCode, 1);
  assert.match(result.errorMessage ?? "", /model exploded/);
});
