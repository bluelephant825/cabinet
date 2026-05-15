"use client";

/**
 * Demo: the two right-side drawers, side by side.
 *
 *  - "AI Editor"  → src/components/ai-panel/ai-panel.tsx   (useAIPanelStore)
 *  - "Task Detail" → src/components/tasks/task-detail-panel.tsx
 *
 * Both are the real components (not mocks) so the comparison always
 * reflects production. We just seed the global stores they read from:
 * open the AI panel + give it a current page, and fetch a conversation
 * meta to feed the task panel. State is restored on unmount so visiting
 * this page doesn't leak into the rest of the app.
 */

import { useEffect, useState, useCallback } from "react";
import { Loader2 } from "lucide-react";
import { AIPanel } from "@/components/ai-panel/ai-panel";
import { TaskDetailPanel } from "@/components/tasks/task-detail-panel";
import { useAIPanelStore } from "@/stores/ai-panel-store";
import { useAppStore } from "@/stores/app-store";
import { useEditorStore } from "@/stores/editor-store";

const DEFAULT_TASK_ID =
  "2026-05-15T15-23-30-013Z-3a52ce78-editor-manual";

const DEMO_PAGE_PATH = "data/demo/example-page";

function SpecRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-[12px] leading-relaxed">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <span className="text-foreground/80">{value}</span>
    </div>
  );
}

export default function DrawersDemoPage() {
  const [taskId, setTaskId] = useState(DEFAULT_TASK_ID);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taskConversation = useAppStore((s) => s.taskPanelConversation);

  const loadTask = useCallback(async (id: string) => {
    const trimmed = id.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/agents/conversations/${encodeURIComponent(trimmed)}`
      );
      if (!res.ok) {
        throw new Error(`Conversation not found (HTTP ${res.status})`);
      }
      const data = await res.json();
      if (!data?.meta) throw new Error("Response had no conversation meta");
      useAppStore.getState().setTaskPanelConversation(data.meta);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load task");
      useAppStore.getState().setTaskPanelConversation(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Seed both drawers on mount; restore globals on unmount.
  useEffect(() => {
    const prevPath = useEditorStore.getState().currentPath;
    // Enable the AI Editor composer without a network round-trip.
    useEditorStore.setState({ currentPath: DEMO_PAGE_PATH });
    useAIPanelStore.getState().open();
    void loadTask(DEFAULT_TASK_ID);

    return () => {
      useAIPanelStore.getState().close();
      useAppStore.getState().setTaskPanelConversation(null);
      useEditorStore.setState({ currentPath: prevPath });
    };
  }, [loadTask]);

  const reopenAi = () => useAIPanelStore.getState().open();

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      {/* Toolbar */}
      <header className="shrink-0 border-b border-border/70 px-6 py-4">
        <h1 className="text-lg font-semibold tracking-tight">
          Drawer comparison — AI Editor vs. Task Detail
        </h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          The two right-side drawers rendered side by side with the live
          components. Best viewed on a wide desktop window.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            value={taskId}
            onChange={(e) => setTaskId(e.target.value)}
            spellCheck={false}
            className="h-8 w-[420px] max-w-full rounded-md border border-border bg-card px-2 font-mono text-[12px] outline-none focus:ring-2 focus:ring-ring"
            placeholder="conversation / task id"
          />
          <button
            onClick={() => void loadTask(taskId)}
            disabled={loading}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-[12px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {loading && <Loader2 className="size-3.5 animate-spin" />}
            Load task
          </button>
          <button
            onClick={reopenAi}
            className="inline-flex h-8 items-center rounded-md border border-border bg-card px-3 text-[12px] font-medium transition-colors hover:bg-accent"
          >
            Re-open AI Editor
          </button>
          {error && (
            <span className="text-[12px] text-destructive">{error}</span>
          )}
        </div>
      </header>

      {/* Side-by-side stage */}
      <div className="flex min-h-0 flex-1 items-stretch gap-8 overflow-auto p-8">
        {/* AI Editor */}
        <section className="flex min-w-0 flex-col gap-3">
          <div className="space-y-1">
            <h2 className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">
              AI Editor drawer
            </h2>
            <div className="space-y-0.5 rounded-lg bg-muted/40 p-3 ring-1 ring-border/50">
              <SpecRow label="Source" value="ai-panel.tsx" />
              <SpecRow label="Width" value="resizable 380–760, default 480" />
              <SpecRow label="Chrome" value="no navbar — X close only" />
              <SpecRow label="Open/close" value="width push/release tween" />
              <SpecRow
                label="Composer"
                value="rounded bg-muted/50 surface, no divider"
              />
            </div>
          </div>
          <div className="flex h-[78vh] overflow-hidden rounded-xl border border-border bg-background shadow-sm">
            <AIPanel />
          </div>
        </section>

        {/* Task Detail */}
        <section className="flex min-w-0 flex-col gap-3">
          <div className="space-y-1">
            <h2 className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">
              Task Detail drawer
            </h2>
            <div className="space-y-0.5 rounded-lg bg-muted/40 p-3 ring-1 ring-border/50">
              <SpecRow label="Source" value="task-detail-panel.tsx" />
              <SpecRow label="Width" value="fixed 420 (or fullscreen)" />
              <SpecRow
                label="Chrome"
                value="header: status, title, fullscreen, X"
              />
              <SpecRow label="Open/close" value="mount/unmount (no tween)" />
              <SpecRow
                label="Body"
                value="TaskConversationPage (compact)"
              />
            </div>
          </div>
          <div className="flex h-[78vh] overflow-hidden rounded-xl border border-border bg-background shadow-sm">
            {taskConversation ? (
              <TaskDetailPanel />
            ) : (
              <div className="flex flex-1 items-center justify-center p-6 text-center text-[13px] text-muted-foreground">
                {loading
                  ? "Loading task…"
                  : "No task loaded — paste a conversation id above and press “Load task”."}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
