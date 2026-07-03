"use client";

/**
 * Renders ```mermaid code blocks as live diagrams inside the markdown editor.
 *
 * Extends CodeBlockLowlight so every OTHER language keeps its normal
 * lowlight-highlighted look; only blocks whose language is `mermaid` get the
 * diagram/source toggle. renderHTML is left untouched, so the block still
 * serializes to a plain ```mermaid fence and files round-trip unchanged.
 *
 * Reuses the same mermaid render path as the standalone MermaidViewer.
 */

import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import {
  ReactNodeViewRenderer,
  NodeViewWrapper,
  NodeViewContent,
  type NodeViewProps,
} from "@tiptap/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Code, Eye, ZoomIn, ZoomOut, Maximize } from "lucide-react";

// Kept identical to the previous CodeBlockLowlight config so non-mermaid
// blocks look exactly as before.
const PRE_CLASS = "rounded-md bg-muted p-4 font-mono text-sm";

// mermaid.render needs a unique, selector-safe DOM id per diagram.
let RENDER_SEQ = 0;

function MermaidCodeBlockView({ node, selected }: NodeViewProps) {
  const isMermaid = String(node.attrs.language ?? "").toLowerCase() === "mermaid";
  const source = node.textContent;

  const [mode, setMode] = useState<"preview" | "edit">(() =>
    source.trim() ? "preview" : "edit",
  );
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  const idRef = useRef(`cabinet-mermaid-${++RENDER_SEQ}`);

  // Zoom + pan (mirrors the standalone MermaidViewer). Wheel needs Ctrl/Cmd so
  // plain scroll still scrolls the page; left-drag pans.
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, px: 0, py: 0 });
  const ZMIN = 0.25;
  const ZMAX = 4;
  const ZSTEP = 0.25;
  const clampZoom = (z: number) => Math.min(Math.max(z, ZMIN), ZMAX);
  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };
  const onWheel = useCallback((e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom((z) => clampZoom(z + (e.deltaY > 0 ? -ZSTEP : ZSTEP)));
  }, []);
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      setIsPanning(true);
      panStart.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [pan],
  );
  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isPanning) return;
      setPan({
        x: panStart.current.px + (e.clientX - panStart.current.x),
        y: panStart.current.py + (e.clientY - panStart.current.y),
      });
    },
    [isPanning],
  );
  const onPointerUp = useCallback(() => setIsPanning(false), []);

  useEffect(() => {
    if (!isMermaid || mode !== "preview") return;
    const src = source.trim();
    if (!src) {
      setSvg("");
      setError("");
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: document.documentElement.classList.contains("dark")
            ? "dark"
            : "default",
          securityLevel: "loose",
          suppressErrorRendering: true,
        });
        await mermaid.parse(src);
        const { svg: rendered } = await mermaid.render(idRef.current, src);
        if (!cancelled) {
          setSvg(rendered);
          setError("");
          setZoom(1);
          setPan({ x: 0, y: 0 });
        }
      } catch (err) {
        // suppressErrorRendering can still leave a stray measuring node behind.
        document.getElementById(idRef.current)?.remove();
        document.getElementById(`d${idRef.current}`)?.remove();
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Invalid diagram");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // ponytail: theme read at render time, not reactive. A theme switch keeps
    // the old diagram colors until the next edit. Add a theme listener if that
    // ever bothers anyone.
  }, [isMermaid, mode, source]);

  // Non-mermaid code blocks: same DOM as the default CodeBlockLowlight so
  // lowlight decorations and styling are unchanged.
  if (!isMermaid) {
    return (
      <NodeViewWrapper as="pre" className={PRE_CLASS}>
        <NodeViewContent<"code"> as="code" />
      </NodeViewWrapper>
    );
  }

  const showDiagram = mode === "preview";

  return (
    <NodeViewWrapper
      as="div"
      className={`group relative my-3 overflow-hidden rounded-lg border border-border bg-card ${
        selected ? "ring-2 ring-primary" : ""
      }`}
    >
      {/* Toggle — floats top-right, appears on hover */}
      <div
        className="absolute right-2 top-2 z-10 inline-flex overflow-hidden rounded-md border border-border text-xs opacity-0 transition-opacity group-hover:opacity-100"
        contentEditable={false}
      >
        <button
          type="button"
          onClick={() => setMode("edit")}
          className={`inline-flex items-center gap-1 px-2 py-1 ${
            mode === "edit"
              ? "bg-primary text-primary-foreground"
              : "bg-background text-muted-foreground hover:bg-accent"
          }`}
        >
          <Code className="h-3 w-3" /> Code
        </button>
        <button
          type="button"
          onClick={() => setMode("preview")}
          className={`inline-flex items-center gap-1 px-2 py-1 ${
            mode === "preview"
              ? "bg-primary text-primary-foreground"
              : "bg-background text-muted-foreground hover:bg-accent"
          }`}
        >
          <Eye className="h-3 w-3" /> Diagram
        </button>
      </div>

      {/* Rendered diagram — fills width, scroll-with-Ctrl to zoom, drag to pan,
          double-click to edit the source. */}
      {showDiagram && (
        <div className="relative">
          {/* Zoom controls (appear on hover) */}
          <div
            className="absolute bottom-2 right-2 z-10 inline-flex items-center gap-0.5 rounded-md border border-border bg-background/90 p-0.5 text-xs opacity-0 backdrop-blur transition-opacity group-hover:opacity-100"
            contentEditable={false}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setZoom((z) => clampZoom(z - ZSTEP))}
              className="rounded p-1 text-muted-foreground hover:bg-accent"
              aria-label="Zoom out"
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </button>
            <span className="w-9 text-center tabular-nums text-muted-foreground select-none">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              onClick={() => setZoom((z) => clampZoom(z + ZSTEP))}
              className="rounded p-1 text-muted-foreground hover:bg-accent"
              aria-label="Zoom in"
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={resetView}
              className="rounded p-1 text-muted-foreground hover:bg-accent"
              aria-label="Reset view"
            >
              <Maximize className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Viewport */}
          <div
            contentEditable={false}
            className="h-[520px] w-full overflow-hidden"
            style={{ cursor: isPanning ? "grabbing" : "grab" }}
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onDoubleClick={() => setMode("edit")}
          >
            {error ? (
              <div className="flex h-full items-center justify-center">
                <span className="text-sm text-red-500">
                  Diagram error: {error}
                </span>
              </div>
            ) : svg ? (
              <div
                className="flex h-full w-full items-center justify-center p-4 [&_svg]:!h-full [&_svg]:!max-h-none [&_svg]:!max-w-none [&_svg]:!w-full"
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                }}
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            ) : (
              <div className="flex h-full items-center justify-center">
                <span className="text-sm text-muted-foreground">Rendering…</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Editable source. Always mounted so ProseMirror keeps the content node;
          hidden (not unmounted) while the diagram shows.
          ponytail: hidden via display:none; edit via the Code toggle, don't
          try to click into it while previewing. */}
      <pre className={showDiagram ? "hidden" : `${PRE_CLASS} !my-0 !rounded-none`}>
        <NodeViewContent<"code"> as="code" />
      </pre>
    </NodeViewWrapper>
  );
}

export const MermaidCodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return ReactNodeViewRenderer(MermaidCodeBlockView);
  },
});
