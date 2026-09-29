// Cabinet adaptation: upstream's docs IPC contract (DesktopApi, AI channels, agent-core/ai-provider types) is shell-facing and not vendored. The vendored docs renderer's ai/style-ops.ts only needs the AgentToolDef shape (JSON-Schema described tool, from @genoffice/agent-core).
export interface AgentToolDef {
  name: string
  description: string
  /** JSON Schema (object) describing the tool input */
  inputSchema: Record<string, unknown>
}
