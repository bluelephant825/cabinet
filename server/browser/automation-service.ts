import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { BrowserAutomationSettings } from "../../src/lib/browser/automation-types";
import { alohaToolCall, BROWSER_TOOL_DESCRIPTORS } from "../../src/lib/browser/automation-tools";
import type { CDPClient } from "./cdp-client";
import { CdpBridge } from "./cdp-bridge";

export type BrowserRunContext = {
  runId: string;
  agentSlug: string;
  cabinetPath?: string;
};

export type BrowserToolResult = {
  content: Array<Record<string, unknown>>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

type AutomationSession = {
  bridge: CdpBridge;
  client: Client;
  transport: StdioClientTransport;
  queue: Promise<unknown>;
  idleTimer: NodeJS.Timeout;
};

type AutomationManager = {
  executable(): Promise<string>;
  childEnvironment(): NodeJS.ProcessEnv | Record<string, string>;
  updateSettings(patch: Partial<BrowserAutomationSettings>): Promise<BrowserAutomationSettings>;
  status(): Promise<{ enabled?: boolean }>;
};

type NativeCall = (
  context: BrowserRunContext,
  name: string,
  args: Record<string, unknown>,
  readTab: (tabId: string) => Promise<BrowserToolResult>,
) => Promise<BrowserToolResult>;

type AutomationServiceOptions = {
  manager: AutomationManager;
  ensureBrowser: () => Promise<void>;
  getCdp: () => CDPClient | null;
  hiddenOrigin?: string;
  maxSessions?: number;
  idleMs?: number;
  nativeCall?: NativeCall;
};

export class BrowserAutomationService {
  private readonly contexts = new Map<string, BrowserRunContext>();
  private readonly sessions = new Map<string, AutomationSession>();
  private readonly targetQueues = new Map<string, Promise<unknown>>();
  private readonly maxSessions: number;
  private readonly idleMs: number;
  private nativeCall?: NativeCall;

  constructor(private readonly options: AutomationServiceOptions) {
    this.maxSessions = options.maxSessions ?? 8;
    this.idleMs = options.idleMs ?? 10 * 60_000;
    this.nativeCall = options.nativeCall;
  }

  setNativeCall(handler: NativeCall): void {
    this.nativeCall = handler;
  }

  registerRun(context: BrowserRunContext): void {
    if (!context.runId.trim()) throw new Error("Browser run id is required");
    this.contexts.set(context.runId, context);
  }

  async releaseRun(runId: string): Promise<void> {
    this.contexts.delete(runId);
    await this.closeSession(runId);
  }

  async updateSettings(patch: Partial<BrowserAutomationSettings>) {
    await this.closeAll();
    return this.options.manager.updateSettings(patch);
  }

  status() {
    return this.options.manager.status();
  }

  tools() {
    return BROWSER_TOOL_DESCRIPTORS;
  }

  async call(
    runId: string,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<BrowserToolResult> {
    const context = this.contexts.get(runId);
    if (!context) throw new Error("Browser automation run is not active");
    if (!(await this.options.manager.status()).enabled) throw new Error("Browser automation is disabled");
    const descriptor = BROWSER_TOOL_DESCRIPTORS.find((entry) => entry.name === name);
    if (!descriptor) throw new Error(`Unknown browser tool: ${name}`);
    if (["browser_download", "browser_save_page", "browser_import_pdf"].includes(name)) {
      if (!this.nativeCall) throw new Error("Cabinet browser imports are unavailable");
      return this.nativeCall(
        context,
        name,
        args,
        (tabId) => this.callAloha(runId, "browser_read", { tabId }, signal),
      );
    }
    return this.callAloha(runId, name, args, signal);
  }

  private async callAloha(
    runId: string,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<BrowserToolResult> {
    const session = await this.session(runId);
    this.touch(runId, session);
    const execute = async () => {
      const mapped = alohaToolCall(name, args);
      if (mapped.selectTabId) {
        const selected = await session.client.callTool(
          { name: "manage_tabs", arguments: { action: "use", tab_id: mapped.selectTabId } },
          undefined,
          { signal, timeout: 30_000, maxTotalTimeout: 30_000 },
        );
        if (selected.isError) return selected as BrowserToolResult;
      }
      return await session.client.callTool(
        { name: mapped.name, arguments: mapped.arguments },
        undefined,
        { signal, timeout: 30_000, maxTotalTimeout: 30_000 },
      ) as BrowserToolResult;
    };
    const targetId = typeof args.tabId === "string" ? args.tabId : undefined;
    const targetQueue = targetId ? this.targetQueues.get(targetId) : undefined;
    const ready = Promise.all([
      session.queue.catch(() => undefined),
      targetQueue?.catch(() => undefined),
    ]);
    const result = ready.then(execute);
    void result.then((value) => {
      if (!value.isError) return;
      const text = value.content
        .filter((item) => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text as string)
        .join("\n");
      if (/could not reach a browser|connection closed|browser session unavailable/i.test(text)) {
        void this.closeSession(runId);
      }
    }).catch(() => {});
    const settled = result.then(() => undefined, () => undefined);
    session.queue = settled;
    if (targetId) {
      this.targetQueues.set(targetId, settled);
      void settled.finally(() => {
        if (this.targetQueues.get(targetId) === settled) this.targetQueues.delete(targetId);
      });
    }
    return result;
  }

  async closeAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.closeSession(id)));
  }

  private async session(runId: string): Promise<AutomationSession> {
    const existing = this.sessions.get(runId);
    if (existing) return existing;
    if (this.sessions.size >= this.maxSessions) {
      throw new Error("Too many browser automation sessions are active");
    }
    const executable = await this.options.manager.executable();
    await this.options.ensureBrowser();
    const cdp = this.options.getCdp();
    if (!cdp) throw new Error("Cabinet Browser is not running");
    const bridge = new CdpBridge(cdp, this.options.hiddenOrigin);
    const endpoint = await bridge.start();
    const transport = new StdioClientTransport({
      command: executable,
      args: ["mcp", "--cdp", endpoint],
      env: this.options.manager.childEnvironment() as Record<string, string>,
      stderr: "pipe",
      maxBufferSize: 16 * 1024 * 1024,
    });
    transport.stderr?.on("data", () => {});
    const client = new Client({ name: "cabinet-browser", version: "1.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport, { timeout: 20_000 });
      const listed = await client.listTools(undefined, { timeout: 10_000 });
      const names = new Set(listed.tools.map((tool) => tool.name));
      for (const required of ["manage_tabs", "page_click", "page_type", "page_select", "get_text", "page_navigate", "page_press_keys", "page_wait_for"]) {
        if (!names.has(required)) throw new Error(`AlohaJet tool is unavailable: ${required}`);
      }
    } catch (error) {
      await client.close().catch(() => {});
      await bridge.close().catch(() => {});
      throw error;
    }
    const idleTimer = setTimeout(() => {
      void this.closeSession(runId);
    }, this.idleMs);
    idleTimer.unref?.();
    const created: AutomationSession = { bridge, client, transport, queue: Promise.resolve(), idleTimer };
    this.sessions.set(runId, created);
    return created;
  }

  private touch(runId: string, session: AutomationSession): void {
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      void this.closeSession(runId);
    }, this.idleMs);
    session.idleTimer.unref?.();
  }

  private async closeSession(runId: string): Promise<void> {
    const session = this.sessions.get(runId);
    if (!session) return;
    this.sessions.delete(runId);
    clearTimeout(session.idleTimer);
    await session.client.close().catch(() => {});
    await session.bridge.close().catch(() => {});
  }
}
