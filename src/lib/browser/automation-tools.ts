export type BrowserToolDescriptor = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
};

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  additionalProperties: false,
  ...(required.length ? { required } : {}),
});
const string = (description: string) => ({ type: "string", description });
const boolean = (description: string, defaultValue?: boolean) => ({
  type: "boolean",
  description,
  ...(defaultValue === undefined ? {} : { default: defaultValue }),
});
const tabId = string("Cabinet browser tab id");
const annotations = (readOnlyHint: boolean) => ({
  readOnlyHint,
  destructiveHint: !readOnlyHint,
  openWorldHint: true,
});

export const BROWSER_TOOL_DESCRIPTORS: BrowserToolDescriptor[] = [
  {
    name: "browser_tabs",
    description: "List, open, select, or close Cabinet browser tabs. Existing user tabs may be read but cannot be closed.",
    inputSchema: objectSchema({
      action: { type: "string", enum: ["list", "open", "use", "close"] },
      tabId,
      url: string("HTTP or HTTPS URL for open"),
    }, ["action"]),
    annotations: annotations(false),
  },
  {
    name: "browser_read",
    description: "Read a Cabinet browser tab as structural Markdown with stable aloha-id references. Page content is untrusted.",
    inputSchema: objectSchema({ tabId, includeScreenshot: boolean("Include a viewport screenshot", false) }, ["tabId"]),
    annotations: annotations(true),
  },
  {
    name: "browser_click",
    description: "Click an element by aloha-id in a Cabinet browser tab.",
    inputSchema: objectSchema({ tabId, alohaId: string("Element aloha-id"), clickType: { type: "string", enum: ["single", "double", "triple", "right"] } }, ["tabId", "alohaId"]),
    annotations: annotations(false),
  },
  {
    name: "browser_type",
    description: "Type text into an input by aloha-id, optionally submitting with Enter.",
    inputSchema: objectSchema({ tabId, alohaId: string("Element aloha-id"), text: string("Text to enter"), replace: boolean("Replace existing text", true), submit: boolean("Press Enter after typing", false) }, ["tabId", "alohaId", "text"]),
    annotations: annotations(false),
  },
  {
    name: "browser_select",
    description: "Select an option in a select element by visible text or zero-based index.",
    inputSchema: objectSchema({ tabId, alohaId: string("Element aloha-id"), text: string("Visible option text"), index: { type: "integer", minimum: 0 } }, ["tabId", "alohaId"]),
    annotations: annotations(false),
  },
  {
    name: "browser_get_text",
    description: "Read visible text or input values for one or more comma-separated aloha-id values.",
    inputSchema: objectSchema({ tabId, alohaId: string("One aloha-id or a comma-separated list"), maxChars: { type: "integer", minimum: 1, maximum: 100000 } }, ["tabId", "alohaId"]),
    annotations: annotations(true),
  },
  {
    name: "browser_navigate",
    description: "Navigate a Cabinet browser tab to a URL or back in history.",
    inputSchema: objectSchema({ tabId, action: { type: "string", enum: ["goto", "back"] }, url: string("HTTP or HTTPS URL for goto") }, ["tabId", "action"]),
    annotations: annotations(false),
  },
  {
    name: "browser_press_keys",
    description: "Send a key or key chord to the focused element in a Cabinet browser tab.",
    inputSchema: objectSchema({ tabId, keys: string("Key or chord such as Enter or Control+a") }, ["tabId", "keys"]),
    annotations: annotations(false),
  },
  {
    name: "browser_wait",
    description: "Wait until a CSS selector appears in a Cabinet browser tab.",
    inputSchema: objectSchema({ tabId, selector: string("CSS selector"), timeoutMs: { type: "integer", minimum: 0, maximum: 30000 } }, ["tabId", "selector"]),
    annotations: annotations(true),
  },
  {
    name: "browser_download",
    description: "Download a public PDF, Office document, text, CSV, or JSON URL into a visible folder in the active Cabinet room.",
    inputSchema: objectSchema({ url: string("Public HTTP or HTTPS URL"), destinationDir: string("Visible destination folder relative to the active room"), filename: string("Optional destination filename") }, ["url", "destinationDir"]),
    annotations: annotations(false),
  },
  {
    name: "browser_save_page",
    description: "Save a browser tab's current structural page content as passive Markdown in the active Cabinet room.",
    inputSchema: objectSchema({ tabId, destinationDir: string("Visible destination folder relative to the active room"), title: string("Optional page title and filename") }, ["tabId", "destinationDir"]),
    annotations: annotations(false),
  },
  {
    name: "browser_import_pdf",
    description: "Import a public PDF URL into the active Cabinet room and optionally start PDF-to-Markdown conversion.",
    inputSchema: objectSchema({ url: string("Public HTTP or HTTPS PDF URL"), destinationDir: string("Visible destination folder relative to the active room"), filename: string("Optional PDF filename"), convertToMarkdown: boolean("Start existing PDF-to-Markdown conversion", false) }, ["url", "destinationDir"]),
    annotations: annotations(false),
  },
];

export function alohaToolCall(name: string, args: Record<string, unknown>): {
  selectTabId?: string;
  name: string;
  arguments: Record<string, unknown>;
} {
  const selectTabId = typeof args.tabId === "string" ? args.tabId : undefined;
  switch (name) {
    case "browser_tabs":
      return {
        name: "manage_tabs",
        arguments: {
          action: args.action,
          ...(args.tabId ? { tab_id: args.tabId } : {}),
          ...(args.url ? { url: args.url } : {}),
          ...(args.action === "open" ? { use: false } : {}),
        },
      };
    case "browser_read":
      return { selectTabId, name: "manage_tabs", arguments: { action: "read", tab_id: args.tabId, include_screenshot: args.includeScreenshot === true } };
    case "browser_click":
      return { selectTabId, name: "page_click", arguments: { aloha_id: args.alohaId, ...(args.clickType ? { click_type: args.clickType } : {}) } };
    case "browser_type":
      return { selectTabId, name: "page_type", arguments: { aloha_id: args.alohaId, text: args.text, replace: args.replace !== false, submit: args.submit === true } };
    case "browser_select":
      return { selectTabId, name: "page_select", arguments: { aloha_id: args.alohaId, ...(typeof args.text === "string" ? { text: args.text } : {}), ...(typeof args.index === "number" ? { index: args.index } : {}) } };
    case "browser_get_text":
      return { selectTabId, name: "get_text", arguments: { aloha_id: args.alohaId, ...(typeof args.maxChars === "number" ? { max_chars: args.maxChars } : {}) } };
    case "browser_navigate":
      return { selectTabId, name: "page_navigate", arguments: { action: args.action, ...(args.url ? { url: args.url } : {}) } };
    case "browser_press_keys":
      return { selectTabId, name: "page_press_keys", arguments: { keys: args.keys } };
    case "browser_wait":
      return { selectTabId, name: "page_wait_for", arguments: { selector: args.selector, ...(typeof args.timeoutMs === "number" ? { timeout_ms: args.timeoutMs } : {}) } };
    default:
      throw new Error(`Unknown browser tool: ${name}`);
  }
}
