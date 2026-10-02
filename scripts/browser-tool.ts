#!/usr/bin/env node
/**
 * `cabinet-browser` — agent-facing CLI for the Cabinet Browser sidecar.
 *
 * Talks to the local daemon over loopback HTTP with the shared daemon token
 * (read from its 0600 file — never printed, never taken as an arg). Every
 * command prints one JSON value to stdout; failures print
 * `{ "error": { code, message } }` and exit non-zero.
 *
 * The browser is a real Chrome for Testing window shared with the user:
 * prefer `text`/`eval` over `screenshot`, and do not close tabs you did not
 * open.
 *
 * Dev: `npx tsx scripts/browser-tool.ts <cmd>` — the packaged shim execs the
 * bundled browser-tool.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDaemonUrl, getOrCreateDaemonTokenSync } from "@/lib/agents/daemon-auth";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { BROWSER_TOOL_DESCRIPTORS } from "@/lib/browser/automation-tools";

class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** A fully resolved daemon request; produced by planCommand, executed by main. */
export type PlannedRequest = {
  method: "GET" | "POST" | "DELETE";
  /** Path under /browser/, e.g. "tabs/ABC123/navigate". */
  path: string;
  body?: Record<string, unknown>;
  /** Read the JSON string field (eval expression) from stdin. */
  expressionFromStdin?: boolean;
  /** Response is a PNG stream to write here instead of printing JSON. */
  screenshotOut?: string;
};

const TAB_ID = /^[A-Za-z0-9_-]+$/;

function tabId(value: string | undefined): string {
  const id = value?.trim() ?? "";
  if (!id) throw new ToolError("invalid", "tab id is required");
  return encodeURIComponent(id);
}

function arg(args: string[], index: number, what: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    throw new ToolError("invalid", `${what} is required`);
  }
  return value;
}

function noExtra(args: string[], count: number): void {
  if (args.length > count) {
    throw new ToolError("invalid", `Unexpected argument: ${args[count]}`);
  }
}

/**
 * Pure argv → daemon-request mapping. Exported so tests can cover the whole
 * dispatch table without a live daemon.
 */
export function planCommand(cmd: string | undefined, args: string[]): PlannedRequest {
  switch (cmd) {
    case "status":
      noExtra(args, 0);
      return { method: "GET", path: "status" };
    case "tabs":
      noExtra(args, 0);
      return { method: "GET", path: "tabs" };
    case "extensions":
      noExtra(args, 0);
      return { method: "GET", path: "extensions" };
    case "open": {
      const url = arg(args, 0, "url");
      noExtra(args, 1);
      return { method: "POST", path: "tabs", body: { url } };
    }
    case "install-extension": {
      const idOrUrl = arg(args, 0, "idOrUrl");
      noExtra(args, 1);
      return { method: "POST", path: "extensions", body: { idOrUrl } };
    }
    case "navigate": {
      const id = arg(args, 0, "tab id");
      const url = arg(args, 1, "url");
      noExtra(args, 2);
      return { method: "POST", path: `tabs/${tabId(id)}/navigate`, body: { url } };
    }
    case "activate":
    case "close":
    case "back":
    case "forward":
    case "reload": {
      const id = arg(args, 0, "tab id");
      noExtra(args, 1);
      return { method: "POST", path: `tabs/${tabId(id)}/${cmd}` };
    }
    case "eval": {
      const id = arg(args, 0, "tab id");
      const expression = arg(args, 1, "expression");
      noExtra(args, 2);
      if (expression === "-") {
        return {
          method: "POST",
          path: `tabs/${tabId(id)}/evaluate`,
          expressionFromStdin: true,
        };
      }
      return {
        method: "POST",
        path: `tabs/${tabId(id)}/evaluate`,
        body: { expression },
      };
    }
    case "text": {
      const id = arg(args, 0, "tab id");
      noExtra(args, 1);
      return { method: "GET", path: `tabs/${tabId(id)}/extract` };
    }
    case "html": {
      const id = arg(args, 0, "tab id");
      noExtra(args, 1);
      return { method: "GET", path: `tabs/${tabId(id)}/extract?html=1` };
    }
    case "screenshot": {
      const id = arg(args, 0, "tab id");
      const out =
        args[1]?.trim() ||
        `/tmp/cabinet-browser-${TAB_ID.test(id) ? id : "tab"}-${Date.now()}.png`;
      noExtra(args, 2);
      return {
        method: "GET",
        path: `tabs/${tabId(id)}/screenshot`,
        screenshotOut: out,
      };
    }
    default:
      throw new ToolError(
        "invalid",
        `Unknown command: ${cmd ?? "(none)"}. Run cabinet-browser --help.`,
      );
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function request(plan: PlannedRequest): Promise<unknown> {
  const token = getOrCreateDaemonTokenSync();
  const body =
    plan.body !== undefined
      ? JSON.stringify(plan.body)
      : plan.expressionFromStdin
        ? JSON.stringify({ expression: await readStdin() })
        : undefined;
  let res: Response;
  try {
    res = await fetch(`${getDaemonUrl()}/browser/${plan.path}`, {
      method: plan.method,
      headers: {
        authorization: `Bearer ${token}`,
        // The daemon treats an absent Origin as a local caller; pin loopback
        // explicitly so the sidecar stays eligible from any spawned cwd.
        "x-cabinet-client-origin": "http://127.0.0.1",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body,
    });
  } catch {
    throw new ToolError(
      "daemon-unreachable",
      `Could not reach the Cabinet daemon at ${getDaemonUrl()} — is it running?`,
    );
  }
  if (plan.screenshotOut) {
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      throw new ToolError(json.code ?? "request-failed", json.error ?? `HTTP ${res.status}`);
    }
    const png = Buffer.from(await res.arrayBuffer());
    const outPath = path.resolve(plan.screenshotOut);
    fs.writeFileSync(outPath, png);
    return { path: outPath };
  }
  const text = await res.text();
  let json: unknown = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const payload = json as { error?: string; code?: string };
    throw new ToolError(payload.code ?? "request-failed", payload.error ?? `HTTP ${res.status}`);
  }
  return json;
}

async function automationCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  const runId = process.env.CABINET_RUN_ID?.trim();
  if (!runId) throw new ToolError("invalid", "CABINET_RUN_ID is required for browser automation");
  const token = getOrCreateDaemonTokenSync();
  const response = await fetch(`${getDaemonUrl()}/browser/automation/call`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "x-cabinet-client-origin": "http://127.0.0.1",
      "content-type": "application/json",
    },
    body: JSON.stringify({ runId, name, arguments: args }),
  }).catch(() => {
    throw new ToolError("daemon-unreachable", `Could not reach the Cabinet daemon at ${getDaemonUrl()}`);
  });
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new ToolError("request-failed", payload.error ?? `HTTP ${response.status}`);
  return payload;
}

async function serveMcp(): Promise<void> {
  const server = new Server(
    { name: "cabinet-browser", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: BROWSER_TOOL_DESCRIPTORS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await automationCall(
        request.params.name,
        (request.params.arguments ?? {}) as Record<string, unknown>,
      ) as never;
    } catch (error) {
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : "Browser tool failed" }],
        isError: true,
      };
    }
  });
  await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 16 * 1024 * 1024 }));
}

export function automationCommand(cmd: string | undefined, args: string[]): { name: string; arguments: Record<string, unknown> } | null {
  switch (cmd) {
    case "tabs":
      return { name: "browser_tabs", arguments: { action: "list" } };
    case "open":
      return { name: "browser_tabs", arguments: { action: "open", url: arg(args, 0, "url") } };
    case "close":
      return { name: "browser_tabs", arguments: { action: "close", tabId: arg(args, 0, "tab id") } };
    case "activate":
      return { name: "browser_tabs", arguments: { action: "use", tabId: arg(args, 0, "tab id") } };
    case "navigate":
      return { name: "browser_navigate", arguments: { tabId: arg(args, 0, "tab id"), action: "goto", url: arg(args, 1, "url") } };
    case "back":
      return { name: "browser_navigate", arguments: { tabId: arg(args, 0, "tab id"), action: "back" } };
    case "read":
      return { name: "browser_read", arguments: { tabId: arg(args, 0, "tab id"), includeScreenshot: args.includes("--screenshot") } };
    case "click":
      return { name: "browser_click", arguments: { tabId: arg(args, 0, "tab id"), alohaId: arg(args, 1, "aloha id") } };
    case "type":
      return { name: "browser_type", arguments: { tabId: arg(args, 0, "tab id"), alohaId: arg(args, 1, "aloha id"), text: arg(args, 2, "text"), submit: args.includes("--submit") } };
    case "wait":
      return { name: "browser_wait", arguments: { tabId: arg(args, 0, "tab id"), selector: arg(args, 1, "selector") } };
    case "select": {
      const indexFlag = args.indexOf("--index");
      return { name: "browser_select", arguments: { tabId: arg(args, 0, "tab id"), alohaId: arg(args, 1, "aloha id"), ...(indexFlag >= 0 ? { index: Number(arg(args, indexFlag + 1, "index")) } : { text: arg(args, 2, "option text") }) } };
    }
    case "get-text":
      return { name: "browser_get_text", arguments: { tabId: arg(args, 0, "tab id"), alohaId: arg(args, 1, "aloha id") } };
    case "keys":
      return { name: "browser_press_keys", arguments: { tabId: arg(args, 0, "tab id"), keys: arg(args, 1, "keys") } };
    case "download":
      return { name: "browser_download", arguments: { url: arg(args, 0, "url"), destinationDir: arg(args, 1, "destination directory"), ...(args[2] ? { filename: args[2] } : {}) } };
    case "save-page":
      return { name: "browser_save_page", arguments: { tabId: arg(args, 0, "tab id"), destinationDir: arg(args, 1, "destination directory"), ...(args[2] ? { title: args[2] } : {}) } };
    case "import-pdf":
      return { name: "browser_import_pdf", arguments: { url: arg(args, 0, "url"), destinationDir: arg(args, 1, "destination directory"), ...(args[2] && !args[2].startsWith("--") ? { filename: args[2] } : {}), convertToMarkdown: args.includes("--convert") } };
    default:
      return null;
  }
}

const HELP = `cabinet-browser — drive the Cabinet Browser (a real Chrome for Testing
window shared with the user, with the user's extensions installed).

Commands:
  status                        Browser status: missing|downloading|stopped|starting|running|error
  tabs                          List tabs (id, url, title, active)
  open <url>                    Open a new tab (launches/downloads the browser on demand)
  navigate <tabId> <url>        Navigate an existing tab
  activate <tabId>              Bring a tab to the front
  close <tabId>                 Close a tab (do not close tabs you did not open)
  back|forward|reload <tabId>   History navigation / reload
  eval <tabId> <expr|->         Runtime.evaluate; '-' reads the expression from stdin
  text <tabId>                  {url,title,text} — page innerText (preferred over screenshot)
  html <tabId>                  Same plus the rendered HTML
  screenshot <tabId> [outPath]  PNG capture (default /tmp/cabinet-browser-<tabId>-<ts>.png)
  extensions                    List installed extensions
  install-extension <idOrUrl>   Install a Chrome Web Store extension by id or URL
  read <tabId> [--screenshot]   Structural Markdown with stable element references
  click <tabId> <alohaId>       Click an element
  type <tabId> <alohaId> <text> [--submit]
  select <tabId> <alohaId> <text>|--index <n>
  get-text <tabId> <alohaId>    Read visible element text
  wait <tabId> <selector>       Wait for a CSS selector
  keys <tabId> <keys>           Send a key or key chord
  download <url> <dir> [name]   Import a public document or text file
  save-page <tabId> <dir> [title]
  import-pdf <url> <dir> [name] [--convert]
  mcp                           Serve Cabinet browser tools over MCP stdio

Every command prints JSON. Errors print {"error":{...}} and exit 1.
`;

async function main(): Promise<void> {
  const [, , cmd, ...args] = process.argv;
  if (cmd === "--help" || cmd === "help" || cmd === undefined) {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === "mcp") {
    await serveMcp();
    return;
  }
  const automation = automationCommand(cmd, args);
  const legacy = new Set(["tabs", "open", "close", "activate", "navigate", "back"]);
  const useAutomation = automation && (!legacy.has(cmd) || Boolean(process.env.CABINET_RUN_ID?.trim()));
  const result = useAutomation
    ? await automationCall(automation.name, automation.arguments)
    : await request(planCommand(cmd, args));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function fail(err: unknown): never {
  const shape =
    err instanceof ToolError
      ? { code: err.code, message: err.message }
      : { code: "internal", message: err instanceof Error ? err.message : String(err) };
  process.stdout.write(`${JSON.stringify({ error: shape }, null, 2)}\n`);
  process.exit(1);
}

// Run only when invoked directly (tsx script, bundled .mjs, or shim exec) —
// tests import planCommand without booting the CLI. Compare realpaths: the
// loader resolves symlinks (e.g. macOS /var → /private/var) while argv[1]
// does not.
const invokedAs = process.argv[1]
  ? fs.realpathSync.native(path.resolve(process.argv[1]))
  : "";
if (invokedAs && invokedAs === fileURLToPath(import.meta.url)) {
  void main().catch(fail);
}
