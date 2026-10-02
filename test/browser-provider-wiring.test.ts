import test from "node:test";
import assert from "node:assert/strict";
import { claudeBrowserMcpArgs, codexBrowserMcpArgs } from "../src/lib/browser/mcp-launch";

function mcpCommand(args: string[]): string | null {
  const index = args.findIndex((arg) => arg === "--mcp-config");
  if (index < 0) return null;
  const config = JSON.parse(args[index + 1]) as { mcpServers: { "cabinet-browser": { command: string; args: string[] } } };
  assert.deepEqual(config.mcpServers["cabinet-browser"].args, ["mcp"]);
  return config.mcpServers["cabinet-browser"].command;
}

test("Claude receives a run-local Cabinet browser MCP server only when enabled", () => {
  assert.deepEqual(claudeBrowserMcpArgs(false), []);
  assert.match(mcpCommand(claudeBrowserMcpArgs(true)) ?? "", /cabinet-browser$/);
});

test("Codex receives run-local Cabinet browser MCP overrides only when enabled", () => {
  assert.deepEqual(codexBrowserMcpArgs(false), []);
  const args = codexBrowserMcpArgs(true);
  assert.ok(args.some((arg) => arg.startsWith("mcp_servers.cabinet-browser.command=")));
  assert.ok(args.includes('mcp_servers.cabinet-browser.args=["mcp"]'));
});
