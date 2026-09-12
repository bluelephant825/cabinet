import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { geminiLocalAdapter } from "./gemini-local";

async function createExecutableScript(source: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-gemini-local-test-"));
  const scriptPath = path.join(dir, "fake-gemini.sh");
  await fs.writeFile(scriptPath, source, "utf8");
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
}

test("geminiLocalAdapter executes a structured stream-json run", async () => {
  const scriptPath = await createExecutableScript(`#!/bin/sh
printf '%s\n' \
  '{"type":"init","timestamp":"2026-04-16T15:39:32.385Z","session_id":"session-123","model":"gemini-3-flash-preview"}' \
  '{"type":"message","timestamp":"2026-04-16T15:39:32.387Z","role":"user","content":"Run pwd, then reply DONE."}' \
  '{"type":"message","timestamp":"2026-04-16T15:39:37.502Z","role":"assistant","content":"Checking the directory.\\n","delta":true}' \
  '{"type":"tool_use","timestamp":"2026-04-16T15:39:37.510Z","tool_name":"run_shell_command","tool_id":"tool-1","parameters":{"command":"pwd","description":"Check cwd"}}' \
  '{"type":"tool_result","timestamp":"2026-04-16T15:39:37.900Z","tool_id":"tool-1","status":"success"}' \
  '{"type":"message","timestamp":"2026-04-16T15:39:38.100Z","role":"assistant","content":"DONE","delta":true}' \
  '{"type":"result","timestamp":"2026-04-16T15:39:38.200Z","status":"success","stats":{"total_tokens":18091,"input_tokens":18054,"output_tokens":37,"cached":0,"models":{"gemini-3-flash-preview":{"total_tokens":18091,"input_tokens":18054,"output_tokens":37,"cached":0}}}}'
printf '%s\n' \
  'YOLO mode is enabled. All tool calls will be automatically approved.' \
  'Meaningful stderr line' >&2
`);

  const chunks: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
  const result = await geminiLocalAdapter.execute?.({
    runId: "run-1",
    adapterType: "gemini_local",
    config: { command: scriptPath },
    prompt: "Say hello",
    cwd: process.cwd(),
    onLog: async (stream, chunk) => {
      chunks.push({ stream, chunk });
    },
  });

  assert.ok(result);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, "Checking the directory.\n$ pwd\nDONE");
  assert.equal(result.summary, "DONE");
  assert.equal(result.provider, "gemini-cli");
  assert.equal(result.model, "gemini-3-flash-preview");
  assert.equal(result.billingType, "unknown");
  assert.equal(result.sessionId, "session-123");
  assert.deepEqual(result.usage, {
    inputTokens: 18054,
    outputTokens: 37,
  });
  assert.deepEqual(chunks, [
    { stream: "stdout", chunk: "Checking the directory.\n$ pwd\nDONE" },
    { stream: "stderr", chunk: "Meaningful stderr line\n" },
  ]);
});

test("Gemini Wiki inference requires and uses a tool-deny policy", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-gemini-wiki-test-"));
  const policyPath = path.join(dir, "wiki-policy.toml");
  await fs.writeFile(policyPath, '[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\n');
  const scriptPath = await createExecutableScript(`#!/bin/sh
policy=''
extensions=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --admin-policy) policy="$2"; shift 2 ;;
    --extensions) extensions="$2"; shift 2 ;;
    --yolo) exit 4 ;;
    *) shift ;;
  esac
done
test -f "$policy" || exit 5
test "$extensions" = none || exit 6
grep -F 'toolName = "*"' "$policy" >/dev/null || exit 7
grep -F 'decision = "deny"' "$policy" >/dev/null || exit 8
printf '%s\\n' '{"type":"message","role":"assistant","content":"{\\"summary\\":[]}","delta":true}' '{"type":"result","status":"success"}'
`);
  await assert.rejects(geminiLocalAdapter.execute!({ runId: "missing-policy", adapterType: "gemini_local", config: { command: scriptPath, inferenceOnly: true }, prompt: "Evidence", cwd: dir, onLog: async () => {} }), /requires a tool-deny policy/);
  const result = await geminiLocalAdapter.execute!({ runId: "wiki", adapterType: "gemini_local", config: { command: scriptPath, inferenceOnly: true, inferencePolicyPath: policyPath }, prompt: "Evidence", cwd: dir, onLog: async () => {} });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, '{"summary":[]}');
  await fs.rm(dir, { recursive: true, force: true });
});
