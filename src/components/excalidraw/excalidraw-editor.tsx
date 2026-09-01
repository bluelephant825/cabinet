"use client";

import { useEffect, useState } from "react";
import {
  Excalidraw,
  exportToSvg,
  loadFromBlob,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import { Loader2, LogOut, Save } from "lucide-react";
import { useTheme } from "@/components/theme-provider";
import { assetUrlFor } from "@/lib/cabinets/asset-url";
import {
  excalidrawFileTitle,
  isExcalidrawSvgPath,
} from "@/lib/excalidraw/files";

const EMPTY_SCENE: ExcalidrawInitialDataState = {
  elements: [],
  appState: {},
  files: {},
};

type SaveState =
  | { kind: "saving"; message: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string }
  | null;

async function responseError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as
    | { error?: unknown }
    | null;
  return typeof body?.error === "string"
    ? body.error
    : `Request failed (${response.status})`;
}

export function ExcalidrawEditor({
  path,
  readOnly = false,
  onSaved,
  onExit,
}: {
  path: string | null;
  readOnly?: boolean;
  onSaved?: () => void;
  onExit?: () => void;
}) {
  const { resolvedTheme } = useTheme();
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [initialData, setInitialData] =
    useState<ExcalidrawInitialDataState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>(null);

  useEffect(() => {
    let cancelled = false;
    if (!path) return;

    void (async () => {
      try {
        const response = await fetch(assetUrlFor(path), { cache: "no-store" });
        if (!response.ok) throw new Error(await responseError(response));
        const blob = await response.blob();
        const scene = await loadFromBlob(blob, null, null);
        if (!cancelled) {
          setInitialData({
            elements: scene.elements ?? [],
            appState: scene.appState ?? {},
            files: scene.files ?? {},
          });
        }
      } catch (error) {
        if (!cancelled) {
          setInitialData(EMPTY_SCENE);
          setLoadError(
            error instanceof Error ? error.message : "Unable to load this drawing."
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [path]);

  const handleSave = async () => {
    if (!api || !path || readOnly) return;
    setSaveState({ kind: "saving", message: "Saving..." });

    try {
      const elements = api.getSceneElements();
      const appState = api.getAppState();
      const files = api.getFiles();
      let body: string;
      let contentType: string;

      if (isExcalidrawSvgPath(path)) {
        const svg = await exportToSvg({
          elements,
          appState: { ...appState, exportEmbedScene: true },
          files,
        });
        body = svg.outerHTML;
        contentType = "image/svg+xml";
      } else {
        body = serializeAsJSON(elements, appState, files, "local");
        contentType = "application/json";
      }

      const response = await fetch(assetUrlFor(path), {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body,
      });
      if (!response.ok) throw new Error(await responseError(response));

      setSaveState({ kind: "success", message: "Saved" });
      onSaved?.();
      window.setTimeout(() => setSaveState(null), 1500);
    } catch (error) {
      setSaveState({
        kind: "error",
        message: error instanceof Error ? error.message : "Save failed.",
      });
    }
  };

  const handleExit = () => {
    if (onExit) onExit();
    else if (window.history.length > 1) window.history.back();
  };

  if (!path) {
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-background text-sm text-destructive">
        No drawing path was provided.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center gap-3 bg-background text-sm text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        Loading drawing...
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground">
      <header className="viewer-toolbar flex h-10 shrink-0 items-center justify-between border-b border-border/70 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            Excalidraw
          </span>
          <span className="truncate text-sm font-medium">
            {path ? excalidrawFileTitle(path) : "Drawing"}
          </span>
          {readOnly ? (
            <span className="text-xs text-muted-foreground">Read only</span>
          ) : null}
          {loadError ? (
            <span className="truncate text-xs text-amber-500" title={loadError}>
              Started with an empty drawing
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {saveState ? (
            <span
              className={
                saveState.kind === "error"
                  ? "max-w-72 truncate text-xs text-destructive"
                  : "text-xs text-muted-foreground"
              }
              title={saveState.message}
            >
              {saveState.message}
            </span>
          ) : null}
          <button
            type="button"
            onClick={handleSave}
            disabled={!api || readOnly || saveState?.kind === "saving"}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saveState?.kind === "saving" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save
          </button>
          <button
            type="button"
            onClick={handleExit}
            className="flex items-center gap-1.5 rounded-md bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/80"
          >
            <LogOut className="h-3.5 w-3.5" />
            Exit
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1">
        <Excalidraw
          excalidrawAPI={setApi}
          initialData={initialData ?? EMPTY_SCENE}
          theme={resolvedTheme === "dark" ? "dark" : "light"}
          viewModeEnabled={readOnly}
        />
      </div>
    </div>
  );
}
