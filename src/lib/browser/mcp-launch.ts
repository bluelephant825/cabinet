import fs from "node:fs";
import path from "node:path";
import { browserToolBinDir } from "./tool-shim";
import { DATA_PARENT_DIR } from "@/lib/storage/path-utils";

export function browserToolCommand(platform: NodeJS.Platform = process.platform): string {
  return path.join(browserToolBinDir(), platform === "win32" ? "cabinet-browser.cmd" : "cabinet-browser");
}

export function browserAutomationEnabled(): boolean {
  try {
    const settings = JSON.parse(
      fs.readFileSync(path.join(DATA_PARENT_DIR, ".devin", "browser-automation.json"), "utf8"),
    ) as { enabled?: unknown };
    return settings.enabled === true;
  } catch {
    return false;
  }
}

export function claudeBrowserMcpConfig(): string {
  return JSON.stringify({
    mcpServers: {
      "cabinet-browser": {
        command: browserToolCommand(),
        args: ["mcp"],
      },
    },
  });
}

export function claudeBrowserMcpArgs(enabled = browserAutomationEnabled()): string[] {
  return enabled ? ["--mcp-config", claudeBrowserMcpConfig()] : [];
}

export function codexBrowserMcpArgs(enabled = browserAutomationEnabled()): string[] {
  if (!enabled) return [];
  return [
    "-c",
    `mcp_servers.cabinet-browser.command=${JSON.stringify(browserToolCommand())}`,
    "-c",
    'mcp_servers.cabinet-browser.args=["mcp"]',
  ];
}
