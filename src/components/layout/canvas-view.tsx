"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, FileText, Folder, Lock, Minus, Plus } from "lucide-react";
import { ViewerToolbar } from "@/components/layout/viewer-toolbar";
import { ToolbarButton } from "@/components/layout/toolbar-button";
import { useAppStore } from "@/stores/app-store";
import { useTreeStore } from "@/stores/tree-store";
import { useEditorStore } from "@/stores/editor-store";
import { ROOT_CABINET_PATH } from "@/lib/cabinets/paths";
import { findNodeByPath } from "@/lib/cabinets/tree";
import { fetchPage } from "@/lib/api/client";
import { markdownToHtml } from "@/lib/markdown/to-html";
import type { TreeNode } from "@/types";
import {
  CANVAS_MAX_CARD_HEIGHT,
  CANVAS_MAX_CARD_WIDTH,
  CANVAS_MAX_ZOOM,
  CANVAS_MIN_CARD_HEIGHT,
  CANVAS_MIN_CARD_WIDTH,
  CANVAS_MIN_ZOOM,
  CANVAS_SNAPSHOT_VERSION,
  computeCanvasAutoLayout,
  emptyCanvasSnapshot,
  parseCanvasSnapshot,
  type CanvasCardState,
  type CanvasSnapshot,
} from "@/lib/canvas/snapshot";

const WORLD_SIZE = 8_000;
const DEFAULT_ZOOM = 1;
const DEFAULT_WIDTH = 360;
const DEFAULT_HEIGHT = 300;
const MINIMAP_SIZE = 180;

type PointerAction =
  | { kind: "pan"; id: number; x: number; y: number; left: number; top: number }
  | { kind: "drag"; id: number; path: string; x: number; y: number; card: CanvasCardState; moved: boolean }
  | { kind: "resize"; id: number; path: string; x: number; y: number; card: CanvasCardState };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isFolder(node: TreeNode): boolean {
  return node.type === "directory" || node.type === "cabinet";
}

function isCanvasCard(node: TreeNode): boolean {
  return isFolder(node) || ["file", "code", "image", "video", "audio", "pdf", "csv"].includes(node.type);
}

function defaultCardSize(): Pick<CanvasCardState, "width" | "height"> {
  return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
}

function assetUrl(nodePath: string): string {
  return `/api/assets/${nodePath.split("/").map(encodeURIComponent).join("/")}`;
}

function csvRows(content: string): string[][] {
  return content.split(/\r?\n/).filter(Boolean).slice(0, 8).map((line) => line.split(",").slice(0, 5));
}

function MarkdownPreview({ content, pagePath }: { content: string; pagePath: string }) {
  const [html, setHtml] = useState("");
  useEffect(() => {
    let active = true;
    void markdownToHtml(content, pagePath).then((value) => active && setHtml(value));
    return () => { active = false; };
  }, [content, pagePath]);
  return html ? (
    <div className="prose prose-sm dark:prose-invert min-h-0 flex-1 max-w-none overflow-auto p-3 text-xs" dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-3 text-xs">{content}</pre>
  );
}

function CardPreview({ node, content, title }: { node: TreeNode; content: string; title: string }) {
  if (node.type === "image") {
    // eslint-disable-next-line @next/next/no-img-element -- arbitrary local cabinet asset.
    return <img src={assetUrl(node.path)} alt={title} draggable={false} className="pointer-events-none min-h-0 flex-1 rounded-md object-cover" />;
  }
  if (node.type === "video") {
    return <video src={assetUrl(node.path)} muted playsInline preload="metadata" className="pointer-events-none min-h-0 flex-1 rounded-md bg-black object-cover" />;
  }
  if (node.type === "audio") {
    return <audio src={assetUrl(node.path)} controls className="mt-8 w-full" />;
  }
  if (node.type === "pdf") {
    return <iframe src={`${assetUrl(node.path)}#toolbar=0&navpanes=0`} title={title} className="pointer-events-none min-h-0 flex-1 rounded-md border-0 bg-muted" />;
  }
  if (node.type === "csv") {
    const rows = csvRows(content);
    return (
      <div className="min-h-0 flex-1 overflow-auto rounded-md bg-muted/40 p-2">
        <table className="w-full table-fixed border-collapse text-[11px]"><tbody>
          {rows.map((row, ri) => <tr key={ri}>{row.map((cell, ci) => <td key={ci} className="truncate border border-border/60 px-1.5 py-1">{cell}</td>)}</tr>)}
        </tbody></table>
      </div>
    );
  }
  if (isFolder(node) && !content) {
    return <div className="flex flex-1 items-center justify-center text-muted-foreground"><Folder className="h-12 w-12 stroke-1" /></div>;
  }
  if (node.type === "file" || isFolder(node)) return <MarkdownPreview content={content} pagePath={node.path} />;
  return <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-xs">{content}</pre>;
}

export function CanvasView() {
  const section = useAppStore((state) => state.section);
  const setSection = useAppStore((state) => state.setSection);
  const setAppMode = useAppStore((state) => state.setAppMode);
  const nodes = useTreeStore((state) => state.nodes);
  const selectedPath = useTreeStore((state) => state.selectedPath);
  const selectPage = useTreeStore((state) => state.selectPage);
  const loadPage = useEditorStore((state) => state.loadPage);
  const cabinetPath = section.cabinetPath || ROOT_CABINET_PATH;

  const boardNode = useMemo(() => {
    const selected = section.type === "page" && selectedPath
      ? findNodeByPath(nodes, selectedPath)
      : null;
    if (selected && isCanvasCard(selected)) return selected;
    const cabinet = findNodeByPath(nodes, cabinetPath);
    return cabinet && isCanvasCard(cabinet) ? cabinet : null;
  }, [cabinetPath, nodes, section.type, selectedPath]);
  const boardPath = boardNode?.path || cabinetPath;
  const cards = useMemo(() => {
    if (!boardNode) return [];
    return isFolder(boardNode)
      ? [boardNode, ...(boardNode.children || []).filter(isCanvasCard)]
      : [boardNode];
  }, [boardNode]);
  const readOnly = boardNode?.knowledgePolicy === "read-only";

  const [snapshot, setSnapshot] = useState<CanvasSnapshot>(emptyCanvasSnapshot);
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [content, setContent] = useState<Record<string, string>>({});
  const [selection, setSelection] = useState<string[]>([]);
  const [viewport, setViewport] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const revisionRef = useRef(0);
  const actionRef = useRef<PointerAction | null>(null);
  const centeredRef = useRef<string | null>(null);

  const board = snapshot.boards[boardPath] || { zoom: DEFAULT_ZOOM, manualLayout: false, cards: {} };
  const zoom = board.zoom;
  const automaticCards = useMemo(() => computeCanvasAutoLayout(cards.map((node) => ({
    path: node.path,
    ...(board.cards[node.path] || defaultCardSize()),
  }))), [board.cards, cards]);
  const cardState = useCallback((path: string) => {
    if (!board.manualLayout && automaticCards[path]) return automaticCards[path];
    return board.cards[path] || automaticCards[path] || {
      x: WORLD_SIZE / 2 - DEFAULT_WIDTH / 2,
      y: WORLD_SIZE / 2 - DEFAULT_HEIGHT / 2,
      ...defaultCardSize(),
    };
  }, [automaticCards, board.cards, board.manualLayout]);

  useEffect(() => {
    let active = true;
    setLoaded(false);
    revisionRef.current = 0;
    setDirty(false);
    setSaveError(null);
    void fetch(`/api/canvas?cabinetPath=${encodeURIComponent(cabinetPath)}`, { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 404) return emptyCanvasSnapshot();
        if (!response.ok) throw new Error("Unable to load canvas");
        const parsed = parseCanvasSnapshot(await response.json());
        if (!parsed) throw new Error("Invalid canvas data");
        return parsed;
      })
      .then((next) => { if (active) { setSnapshot(next); setLoaded(true); } })
      .catch((error) => { if (active) { setSnapshot(emptyCanvasSnapshot()); setLoaded(true); setSaveError(error instanceof Error ? error.message : "Unable to load canvas"); } });
    return () => { active = false; };
  }, [cabinetPath]);

  useEffect(() => {
    if (!loaded || !dirty || readOnly) return;
    const timer = window.setTimeout(() => {
      const savingRevision = revisionRef.current;
      void fetch(`/api/canvas?cabinetPath=${encodeURIComponent(cabinetPath)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(snapshot),
      }).then(async (response) => {
        if (!response.ok) {
          const data = await response.json().catch(() => ({})) as { error?: string };
          throw new Error(data.error || "Unable to save canvas");
        }
        if (revisionRef.current === savingRevision) setDirty(false);
        setSaveError(null);
      }).catch((error) => setSaveError(error instanceof Error ? error.message : "Unable to save canvas"));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [cabinetPath, dirty, loaded, readOnly, snapshot]);

  useEffect(() => {
    setSelection([]);
    const missing = cards.filter((node) => content[node.path] === undefined && ["file", "code", "csv", "directory", "cabinet"].includes(node.type));
    if (!missing.length) return;
    let active = true;
    void Promise.all(missing.map(async (node) => {
      try { return [node.path, (await fetchPage(node.path)).content || ""] as const; }
      catch { return [node.path, ""] as const; }
    })).then((entries) => active && setContent((current) => ({ ...current, ...Object.fromEntries(entries) })));
    return () => { active = false; };
  }, [boardPath, cards, content]);

  const updateBoard = useCallback((change: (current: typeof board) => typeof board) => {
    setSnapshot((current) => {
      const previous = current.boards[boardPath] || { zoom: DEFAULT_ZOOM, manualLayout: false, cards: {} };
      return { ...current, version: CANVAS_SNAPSHOT_VERSION, boards: { ...current.boards, [boardPath]: change(previous) } };
    });
    revisionRef.current += 1;
    setDirty(true);
  }, [boardPath]);

  const updateViewport = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    setViewport({ left: element.scrollLeft / zoom, top: element.scrollTop / zoom, width: element.clientWidth / zoom, height: element.clientHeight / zoom });
  }, [zoom]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!loaded || !element || centeredRef.current === `${cabinetPath}:${boardPath}`) return;
    const states = cards.map((node) => cardState(node.path));
    const left = states.length ? Math.min(...states.map((item) => item.x)) : WORLD_SIZE / 2;
    const right = states.length ? Math.max(...states.map((item) => item.x + item.width)) : WORLD_SIZE / 2;
    const top = states.length ? Math.min(...states.map((item) => item.y)) : WORLD_SIZE / 2;
    const bottom = states.length ? Math.max(...states.map((item) => item.y + item.height)) : WORLD_SIZE / 2;
    element.scrollLeft = ((left + right) / 2) * zoom - element.clientWidth / 2;
    element.scrollTop = ((top + bottom) / 2) * zoom - element.clientHeight / 2;
    centeredRef.current = `${cabinetPath}:${boardPath}`;
    updateViewport();
  }, [boardPath, cabinetPath, cardState, cards, loaded, updateViewport, zoom]);

  useEffect(() => { updateViewport(); }, [updateViewport]);

  const setZoom = (value: number) => {
    const element = scrollRef.current;
    const next = clamp(value, CANVAS_MIN_ZOOM, CANVAS_MAX_ZOOM);
    const centerX = element ? (element.scrollLeft + element.clientWidth / 2) / zoom : WORLD_SIZE / 2;
    const centerY = element ? (element.scrollTop + element.clientHeight / 2) / zoom : WORLD_SIZE / 2;
    updateBoard((current) => ({ ...current, zoom: next }));
    requestAnimationFrame(() => {
      if (!element) return;
      element.scrollLeft = centerX * next - element.clientWidth / 2;
      element.scrollTop = centerY * next - element.clientHeight / 2;
      updateViewport();
    });
  };

  const openCard = (node: TreeNode) => {
    selectPage(node.path);
    void loadPage(node.path);
    setSection({ type: node.type === "cabinet" ? "cabinet" : "page", cabinetPath });
    setAppMode("edit");
  };

  const pointerMove = (event: React.PointerEvent) => {
    const action = actionRef.current;
    if (!action || action.id !== event.pointerId) return;
    if (action.kind === "pan") {
      const element = scrollRef.current;
      if (element) { element.scrollLeft = action.left - (event.clientX - action.x); element.scrollTop = action.top - (event.clientY - action.y); updateViewport(); }
      return;
    }
    const dx = (event.clientX - action.x) / zoom;
    const dy = (event.clientY - action.y) / zoom;
    if (action.kind === "drag") {
      action.moved ||= Math.abs(dx) + Math.abs(dy) > 3;
      if (!action.moved) return;
      updateBoard((current) => {
        const cardsAtAutomaticPositions = current.manualLayout ? current.cards : Object.fromEntries(
          cards.map((node) => [node.path, automaticCards[node.path] || cardState(node.path)]),
        );
        return {
          ...current,
          manualLayout: true,
          cards: {
            ...cardsAtAutomaticPositions,
            [action.path]: { ...action.card, x: action.card.x + dx, y: action.card.y + dy },
          },
        };
      });
    } else {
      updateBoard((current) => ({ ...current, cards: { ...current.cards, [action.path]: { ...action.card, width: clamp(action.card.width + dx, CANVAS_MIN_CARD_WIDTH, CANVAS_MAX_CARD_WIDTH), height: clamp(action.card.height + dy, CANVAS_MIN_CARD_HEIGHT, CANVAS_MAX_CARD_HEIGHT) } } }));
    }
  };

  const pointerUp = (event: React.PointerEvent) => {
    if (actionRef.current?.id === event.pointerId) actionRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewerToolbar path={boardPath} showModeButtons={false} badge="Canvas">
        {readOnly && <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Lock className="h-3.5 w-3.5" /> Read only</span>}
        {saveError && <span className="max-w-48 truncate text-xs text-destructive" title={saveError}>{saveError}</span>}
        <ToolbarButton icon={Minus} label="Zoom out" iconOnly onClick={() => setZoom(zoom - 0.1)} />
        <span className="w-11 text-center text-xs tabular-nums text-muted-foreground">{Math.round(zoom * 100)}%</span>
        <ToolbarButton icon={Plus} label="Zoom in" iconOnly onClick={() => setZoom(zoom + 0.1)} />
        <ToolbarButton icon={Archive} label="Exit canvas" iconOnly onClick={() => setAppMode("edit")} />
      </ViewerToolbar>
      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 touch-none overflow-auto bg-muted/20 cursor-grab active:cursor-grabbing"
        onScroll={updateViewport}
        onPointerDown={(event) => {
          if (event.target !== event.currentTarget && (event.target as HTMLElement).dataset.canvasWorld !== "true") return;
          setSelection([]);
          actionRef.current = { kind: "pan", id: event.pointerId, x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
        onWheel={(event) => {
          if (!event.ctrlKey && !event.metaKey) return;
          event.preventDefault();
          setZoom(zoom * (event.deltaY > 0 ? 0.9 : 1.1));
        }}
      >
        <div data-canvas-world="true" className="relative origin-top-left" style={{ width: WORLD_SIZE * zoom, height: WORLD_SIZE * zoom }}>
          <div data-canvas-world="true" className="absolute inset-0 origin-top-left" style={{ width: WORLD_SIZE, height: WORLD_SIZE, transform: `scale(${zoom})`, backgroundImage: "radial-gradient(circle, color-mix(in srgb, currentColor 14%, transparent) 1px, transparent 1px)", backgroundSize: "24px 24px" }}>
            {cards.map((node) => {
              const state = cardState(node.path);
              const selected = selection.includes(node.path);
              const title = node.frontmatter?.title || node.name;
              return (
                <article
                  key={node.path}
                  className={`absolute flex select-none flex-col overflow-hidden rounded-xl border bg-background p-2 shadow-sm transition-shadow ${selected ? "border-primary ring-2 ring-primary/25 shadow-md" : "border-border/80 hover:shadow-md"}`}
                  style={{ left: state.x, top: state.y, width: state.width, height: state.height }}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (event.metaKey || event.ctrlKey || event.shiftKey) setSelection((current) => current.includes(node.path) ? current.filter((path) => path !== node.path) : [...current, node.path]);
                    else setSelection([node.path]);
                  }}
                  onDoubleClick={() => openCard(node)}
                >
                  <div
                    className={`mb-2 flex h-7 shrink-0 items-center gap-2 rounded-md px-1.5 text-xs font-medium ${readOnly ? "cursor-default" : "cursor-move"}`}
                    onPointerDown={(event) => {
                      if (readOnly) return;
                      event.stopPropagation();
                      setSelection([node.path]);
                      actionRef.current = { kind: "drag", id: event.pointerId, path: node.path, x: event.clientX, y: event.clientY, card: state, moved: false };
                      scrollRef.current?.setPointerCapture(event.pointerId);
                    }}
                  >
                    {isFolder(node) ? <Folder className="h-3.5 w-3.5" /> : <FileText className="h-3.5 w-3.5" />}
                    <span className="truncate">{title}</span>
                  </div>
                  <CardPreview node={node} content={content[node.path] || ""} title={title} />
                  {!readOnly && <button
                    type="button"
                    aria-label={`Resize ${title}`}
                    className="absolute bottom-0 right-0 h-5 w-5 cursor-se-resize rounded-tl border-l border-t border-border bg-muted/70"
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      actionRef.current = { kind: "resize", id: event.pointerId, path: node.path, x: event.clientX, y: event.clientY, card: state };
                      scrollRef.current?.setPointerCapture(event.pointerId);
                    }}
                  />}
                </article>
              );
            })}
          </div>
        </div>
        <button
          type="button"
          aria-label="Canvas minimap"
          className="fixed bottom-10 right-8 z-20 overflow-hidden rounded-lg border border-border bg-background/90 shadow-lg backdrop-blur"
          style={{ width: MINIMAP_SIZE, height: MINIMAP_SIZE }}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const element = scrollRef.current;
            if (!element) return;
            const x = ((event.clientX - rect.left) / rect.width) * WORLD_SIZE;
            const y = ((event.clientY - rect.top) / rect.height) * WORLD_SIZE;
            element.scrollLeft = x * zoom - element.clientWidth / 2;
            element.scrollTop = y * zoom - element.clientHeight / 2;
            updateViewport();
          }}
        >
          {cards.map((node) => {
            const state = cardState(node.path);
            return <span key={node.path} className="absolute rounded-sm bg-foreground/45" style={{ left: `${state.x / WORLD_SIZE * 100}%`, top: `${state.y / WORLD_SIZE * 100}%`, width: `${Math.max(1, state.width / WORLD_SIZE * 100)}%`, height: `${Math.max(1, state.height / WORLD_SIZE * 100)}%` }} />;
          })}
          <span className="absolute border border-primary bg-primary/10" style={{ left: `${viewport.left / WORLD_SIZE * 100}%`, top: `${viewport.top / WORLD_SIZE * 100}%`, width: `${viewport.width / WORLD_SIZE * 100}%`, height: `${viewport.height / WORLD_SIZE * 100}%` }} />
        </button>
      </div>
    </div>
  );
}
