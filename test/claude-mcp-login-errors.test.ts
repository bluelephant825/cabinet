import test from "node:test";
import assert from "node:assert/strict";
import { friendlyLoginError } from "@/lib/agents/claude-mcp-login";

test("maps Meta's DCR refusal to copy that names the cause and the fix", () => {
  const raw = 'Error: {"error":"invalid_client_metadata","error_description":"Dynamic registration is not available for this client."}';
  const mapped = friendlyLoginError(raw, "cabinet-meta-ads");
  assert.ok(mapped, "expected a mapped message");
  assert.match(mapped, /Claude Code/);
});

test("leaves unrecognized errors alone so we never mask a real failure", () => {
  assert.equal(friendlyLoginError("Error: connection refused", "cabinet-meta-ads"), null);
});

test("returns null for empty output", () => {
  assert.equal(friendlyLoginError("", "cabinet-meta-ads"), null);
});

test("does not map the same DCR-refusal string for a different server", () => {
  const raw = 'Error: {"error":"invalid_client_metadata","error_description":"Dynamic registration is not available for this client."}';
  assert.equal(friendlyLoginError(raw, "cabinet-some-other-server"), null);
});
