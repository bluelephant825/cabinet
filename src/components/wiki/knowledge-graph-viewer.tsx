"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Sigma from "sigma";
import { ViewerLayout } from "@/components/layout/viewer-layout";
import { ViewerToolbar } from "@/components/layout/viewer-toolbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { GraphEdge, GraphNode, WikiGraph } from "../../lib/llm-wiki/graph/types";
import { dedupFetch } from "@/lib/api/dedup-fetch";
import {
  applyLayout, buildGraph, communityLegend, communityPalette, defaultFilters, edgeVisible,
  layerMemberSet, legendKey, nodeColor, nodeMatches, nodeVisible, typeLegend,
  EXPLICIT_EDGE_TYPES, INFERRED_EDGE_TYPES, NODE_TYPES, type ColorMode, type GraphFilters,
} from "./knowledge-graph-model";

const roomHref = (path: string) => `/room/${path.split("/").map(encodeURIComponent).join("/")}`;

type Phase =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: WikiGraph };

function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />{label}</label>;
}

export default function KnowledgeGraphViewer({ path, onNotGraph }: { path: string; title: string; onNotGraph: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [filters, setFilters] = useState<GraphFilters>(defaultFilters);
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [webgl, setWebgl] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const stateRef = useRef({ filters, selected, hovered, palette: new Map<number, string>() });
  useEffect(() => { stateRef.current = { ...stateRef.current, filters, selected, hovered }; });
  const onNotGraphRef = useRef(onNotGraph);
  useEffect(() => { onNotGraphRef.current = onNotGraph; });

  const data = phase.kind === "ready" ? phase.data : null;
  const built = useMemo(() => {
    if (!data) return null;
    const graph = buildGraph(data);
    applyLayout(graph);
    return graph;
  }, [data]);
  const nodesById = useMemo(() => new Map((data?.nodes ?? []).map((node) => [node.id, node])), [data]);
  const layerMembers = useMemo(() => (data ? layerMemberSet(data, filters.layer) : null), [data, filters.layer]);
  const palette = useMemo(() => (data ? communityPalette(data) : new Map<number, string>()), [data]);
  useEffect(() => { stateRef.current = { ...stateRef.current, palette }; }, [palette]);
  const legend = useMemo(() => {
    if (!data) return [];
    if (filters.colorMode === "type") return typeLegend(data);
    return communityLegend(data).map((entry) => ({
      key: `community:${entry.community}`, color: entry.color, label: entry.label, size: entry.size,
    }));
  }, [data, filters.colorMode]);
  const visibleNodes = useMemo(() => {
    if (!data) return [];
    return data.nodes.filter((node) => nodeVisible(node, filters, layerMembers));
  }, [data, filters, layerMembers]);

  useEffect(() => {
    const controller = new AbortController();
    setPhase({ kind: "loading" });
    // No signal on the shared request: a StrictMode remount must not abort the
    // in-flight fetch the second mount joins.
    dedupFetch(`/api/llm-wiki/graph?path=${encodeURIComponent(path)}`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          if (body.error === "Not a Wiki graph") { onNotGraphRef.current(); return; }
          if (body.error === "No knowledge graph yet") { setPhase({ kind: "empty" }); return; }
          throw new Error(body.error ?? `Request failed (${response.status})`);
        }
        if (body.kind !== "cabinet-wiki-graph") { onNotGraphRef.current(); return; }
        setPhase({ kind: "ready", data: body as WikiGraph });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => controller.abort();
  }, [path, attempt]);

  useEffect(() => {
    const canvas = document.createElement("canvas");
    setWebgl(!!canvas.getContext("webgl2") || !!canvas.getContext("webgl"));
  }, []);

  // Sigma lifecycle: created once per graph; filters/hover flow through reducers.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !built || !webgl) return;
    // Reducers must read stateRef at call time: destructuring once here would
    // capture the state from Sigma creation forever.
    let memberCache: { layer: string | null | undefined; set: Set<string> | null } = { layer: undefined, set: null };
    let neighborCache: { focus: string | null | undefined; set: Set<string> | null } = { focus: undefined, set: null };
    const reducers = {
      node: (id: string, attrs: Record<string, unknown>) => {
        const { filters, selected, hovered, palette } = stateRef.current;
        if (memberCache.layer !== filters.layer) memberCache = { layer: filters.layer, set: layerMemberSet(data!, filters.layer) };
        const focus = hovered ?? selected;
        if (neighborCache.focus !== focus) neighborCache = { focus, set: focus ? new Set(built.neighbors(focus)) : null };
        const neighbors = neighborCache.set;
        const record = attrs.record as GraphNode;
        if (!nodeVisible(record, filters, memberCache.set)) return { ...attrs, hidden: true };
        const color = nodeColor(record, filters.colorMode, palette);
        const dimmed = neighbors
          ? id !== focus && !neighbors.has(id)
          : (!!filters.search && !nodeMatches(record, filters.search))
            || (!!filters.legendFocus && legendKey(record, filters.colorMode, palette) !== filters.legendFocus);
        if (dimmed) return { ...attrs, color: "#9ca3af", label: "" };
        if (focus === id || (!focus && filters.search && nodeMatches(record, filters.search))) return { ...attrs, color, highlighted: true };
        return { ...attrs, color };
      },
      edge: (id: string, attrs: Record<string, unknown>) => {
        const { filters, selected, hovered } = stateRef.current;
        const focus = hovered ?? selected;
        const records = attrs.records as GraphEdge[];
        if (!records.some((edge) => edgeVisible(edge, filters))) return { ...attrs, hidden: true };
        if (focus) {
          const edge = built.extremities(id);
          if (edge[0] !== focus && edge[1] !== focus) return { ...attrs, color: "#e5e5e5", hidden: false };
          return { ...attrs, color: "#64748b", size: 2 };
        }
        return attrs;
      },
    };
    const sigma = new Sigma(built, container, {
      renderEdgeLabels: false,
      defaultEdgeType: "line",
      labelRenderedSizeThreshold: 8,
      nodeReducer: reducers.node,
      edgeReducer: reducers.edge,
    });
    sigmaRef.current = sigma;
    sigma.on("enterNode", ({ node }) => setHovered(node));
    sigma.on("leaveNode", () => setHovered(null));
    sigma.on("clickNode", ({ node }) => setSelected(node));
    sigma.on("clickStage", () => setSelected(null));
    // Sigma tracks window resizes only; panel/fullscreen toggles resize the
    // container without firing one. scheduleRender repaints (render() resizes
    // internally) - a bare resize() would clear the canvases and stay blank.
    const observer = new ResizeObserver(() => sigma.scheduleRender());
    observer.observe(container);
    return () => { observer.disconnect(); sigma.kill(); sigmaRef.current = null; };
  }, [built, webgl, data]);

  // Re-apply reducers when interaction state changes.
  useEffect(() => { sigmaRef.current?.refresh(); }, [filters, selected, hovered]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setSelected(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const focusFirstMatch = () => {
    if (!built) return;
    const target = visibleNodes.find((node) => nodeMatches(node, filters.search))?.id;
    if (!target) return;
    setSelected(target);
    const sigma = sigmaRef.current;
    if (!sigma) return;
    const attrs = built.getNodeAttributes(target);
    // The camera tracks framed-graph coordinates, not raw graphology x/y.
    const framed = sigma.viewportToFramedGraph(sigma.graphToViewport({ x: attrs.x as number, y: attrs.y as number }));
    sigma.getCamera().animate({ x: framed.x, y: framed.y, ratio: 0.4 }, { duration: 300 });
  };

  const toggle = (set: ReadonlySet<string>, key: string, value: boolean) => {
    const next = new Set(set);
    if (value) next.add(key); else next.delete(key);
    return next;
  };

  const renderToolbar = () => (
    <div className="flex w-52 shrink-0 flex-col gap-3 overflow-y-auto border-r border-border p-3">
      <Input aria-label="Search nodes" placeholder="Search nodes" value={filters.search}
        onChange={(event) => setFilters((f) => ({ ...f, search: event.target.value }))}
        onKeyDown={(event) => { if (event.key === "Enter") focusFirstMatch(); }} />
      <fieldset className="space-y-1">
        <legend className="text-xs font-medium text-muted-foreground">Node types</legend>
        {NODE_TYPES.map((type) => <Checkbox key={type} label={type} checked={filters.nodeTypes.has(type)}
          onChange={(value) => setFilters((f) => ({ ...f, nodeTypes: toggle(f.nodeTypes, type, value) }))} />)}
      </fieldset>
      <fieldset className="space-y-1">
        <legend className="text-xs font-medium text-muted-foreground">Explicit edges</legend>
        {EXPLICIT_EDGE_TYPES.map((type) => <Checkbox key={type} label={type} checked={filters.edgeTypes.has(type)}
          onChange={(value) => setFilters((f) => ({ ...f, edgeTypes: toggle(f.edgeTypes, type, value) }))} />)}
      </fieldset>
      <fieldset className="space-y-1">
        <legend className="text-xs font-medium text-muted-foreground">Inferred edges</legend>
        {INFERRED_EDGE_TYPES.map((type) => <Checkbox key={type} label={type} checked={filters.edgeTypes.has(type)}
          onChange={(value) => setFilters((f) => ({ ...f, edgeTypes: toggle(f.edgeTypes, type, value) }))} />)}
      </fieldset>
      <label className="flex items-center gap-2 text-xs"><Switch checked={filters.showInferred}
        onCheckedChange={(value) => setFilters((f) => ({ ...f, showInferred: value }))} />Show inferred</label>
      <label className="text-xs">Min confidence {filters.minConfidence.toFixed(2)}
        <input type="range" min={0} max={1} step={0.05} value={filters.minConfidence} aria-label="Minimum inferred edge confidence"
          className="mt-1 w-full" onChange={(event) => setFilters((f) => ({ ...f, minConfidence: Number(event.target.value) }))} /></label>
      {!!data?.layers.length && <label className="text-xs">Layer
        <select aria-label="Layer" className="mt-1 w-full rounded-md border border-border bg-background p-1.5" value={filters.layer ?? ""}
          onChange={(event) => setFilters((f) => ({ ...f, layer: event.target.value || null }))}>
          <option value="">All</option>
          {data.layers.map((layer) => <option key={layer.id} value={layer.id}>{layer.name}</option>)}
        </select></label>}
      <fieldset className="space-y-1">
        <legend className="text-xs font-medium text-muted-foreground">Color by</legend>
        <div className="flex gap-1">
          {(["community", "type"] as ColorMode[]).map((mode) => (
            <Button key={mode} size="sm" variant={filters.colorMode === mode ? "default" : "outline"}
              aria-pressed={filters.colorMode === mode}
              onClick={() => setFilters((f) => ({ ...f, colorMode: mode, legendFocus: null }))}>
              {mode === "community" ? "Community" : "Type"}
            </Button>
          ))}
        </div>
      </fieldset>
      <fieldset className="space-y-1">
        <legend className="text-xs font-medium text-muted-foreground">Legend</legend>
        <ul className="space-y-0.5">
          {legend.map((entry) => (
            <li key={entry.key}>
              <button type="button" aria-pressed={filters.legendFocus === entry.key}
                title={`${entry.label} (${entry.size})`}
                className={`flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs ${filters.legendFocus === entry.key ? "bg-muted" : ""}`}
                onClick={() => setFilters((f) => ({ ...f, legendFocus: f.legendFocus === entry.key ? null : entry.key }))}>
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: entry.color }} />
                <span className="line-clamp-2 min-w-0 flex-1">{entry.label}</span>
                <span className="shrink-0 text-muted-foreground">{entry.size}</span>
              </button>
            </li>
          ))}
          <li className="flex items-center gap-1.5 px-1 py-0.5 text-xs">
            <span className="h-0.5 w-4 shrink-0" style={{ background: "#cbd5e1" }} />Explicit edge
          </li>
          <li className="flex items-center gap-1.5 px-1 py-0.5 text-xs">
            <span className="h-0.5 w-4 shrink-0" style={{ background: "#c4b5fd" }} />Inferred edge
          </li>
        </ul>
      </fieldset>
    </div>
  );

  const selectedNode = selected ? nodesById.get(selected) ?? null : null;
  const selectedEdges = useMemo(() => {
    if (!data || !selected) return new Map<string, { edge: GraphEdge; other: GraphNode | undefined; outgoing: boolean }[]>();
    const groups = new Map<string, { edge: GraphEdge; other: GraphNode | undefined; outgoing: boolean }[]>();
    for (const edge of data.edges) {
      const outgoing = edge.source === selected, incoming = edge.target === selected;
      if (!outgoing && !incoming) continue;
      const other = nodesById.get(outgoing ? edge.target : edge.source);
      groups.set(edge.type, [...(groups.get(edge.type) ?? []), { edge, other, outgoing }]);
    }
    return groups;
  }, [data, selected, nodesById]);

  const renderDetail = () => {
    if (!selectedNode) return <p className="p-4 text-xs text-muted-foreground">Select a node to see its details and edges.</p>;
    const node = selectedNode;
    return (
      <div className="space-y-4 p-4 text-sm">
        <div>
          <h2 className="font-semibold break-words">{node.name}</h2>
          <p className="text-xs text-muted-foreground">{node.type}{node.pageKind ? ` · ${node.pageKind}` : ""}{node.category ? ` · ${node.category}` : ""}</p>
        </div>
        {node.summary && <p className="text-xs text-muted-foreground">{node.summary}</p>}
        {!!node.tags.length && <div className="flex flex-wrap gap-1">{node.tags.map((tag) => <span key={tag} className="rounded-full bg-muted px-2 py-0.5 text-xs">{tag}</span>)}</div>}
        {node.pagePath && node.type === "page" && node.pagePath.endsWith(".md") &&
          <a className="block text-xs underline" href={roomHref(node.pagePath)}>Open page</a>}
        {node.type === "source" && node.pagePath && <a className="block text-xs underline" href={roomHref(node.pagePath)}>Open source</a>}
        {[...selectedEdges.entries()].map(([type, entries]) => (
          <div key={type}>
            <h3 className="mb-1 text-xs font-medium uppercase text-muted-foreground">{type.replace(/_/g, " ")}</h3>
            <ul className="space-y-2">
              {entries.map(({ edge, other, outgoing }, index) => (
                <li key={index} className="text-xs">
                  <button type="button" className="text-left underline break-words" onClick={() => other && setSelected(other.id)}>
                    {outgoing ? "→" : "←"} {other?.name ?? (outgoing ? edge.target : edge.source)}
                  </button>
                  <span className={`ml-1 rounded px-1 py-0.5 text-[10px] ${edge.provenance === "explicit" ? "bg-muted" : "bg-amber-100 dark:bg-amber-900"}`}>{edge.provenance}</span>
                  {edge.provenance === "inferred" && <span className="ml-1 text-muted-foreground">{edge.confidence.toFixed(2)} · {edge.extractor}</span>}
                  {edge.description && <p className="mt-0.5 text-muted-foreground">{edge.description}</p>}
                  {edge.evidence?.slice(0, 3).map((evidence, evidenceIndex) => (
                    <blockquote key={evidenceIndex} className="mt-1 border-l-2 border-border pl-2 text-muted-foreground">
                      {evidence.quote.length > 200 ? `${evidence.quote.slice(0, 200)}...` : evidence.quote}
                    </blockquote>
                  ))}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    );
  };

  return (
    <ViewerLayout
      toolbar={
        <ViewerToolbar path={path} badge="GRAPH"
          sublabel={data ? `${data.stats.nodes} nodes, ${data.stats.edges} edges · generated ${new Date(data.generatedAt).toLocaleString()}` : undefined}>
          {!!data?.warnings.length && (
            <details className="relative text-xs">
              <summary className="cursor-pointer select-none rounded-md px-2 py-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground">Warnings ({data.warnings.length})</summary>
              <pre className="absolute right-0 top-full z-10 max-h-64 w-[32rem] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-popover p-2 text-muted-foreground shadow-md">{data.warnings.slice(0, 50).join("\n")}</pre>
            </details>
          )}
        </ViewerToolbar>
      }
    >
    <div className="flex min-h-0 flex-1 bg-background">
        {phase.kind === "loading" && <div className="flex-1 p-8 text-sm text-muted-foreground" role="status">Loading graph...</div>}
        {phase.kind === "empty" && <div className="flex-1 p-8 text-sm text-muted-foreground" role="status">No knowledge graph yet. Run a Wiki operation (for example Check Wiki health in Settings) to build it.</div>}
        {phase.kind === "error" && (
          <div className="flex-1 space-y-3 p-8 text-sm" role="status">
            <p className="text-destructive">{phase.message}</p>
            <Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>Retry</Button>
          </div>
        )}
        {data && (
          <>
            {renderToolbar()}
            <div className="relative min-w-0 flex-1">
              {webgl
                ? <div ref={containerRef} className="absolute inset-0" role="img" aria-label="Knowledge graph canvas" />
                : <div className="absolute inset-0 overflow-auto p-4" role="status">
                    <p className="text-sm">Graph rendering needs WebGL.</p>
                    <ul className="mt-2 space-y-1 text-xs">
                      {legend.map((entry) => (
                        <li key={entry.key} className="flex items-center gap-1.5">
                          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: entry.color }} />
                          {entry.label} <span className="text-muted-foreground">{entry.size}</span>
                        </li>
                      ))}
                    </ul>
                    <ul className="mt-2 space-y-1 text-xs">
                      {visibleNodes.map((node) => <li key={node.id}><button type="button" className="underline" onClick={() => setSelected(node.id)}>{node.name}</button></li>)}
                    </ul>
                  </div>}
            </div>
            <aside className="w-80 shrink-0 overflow-y-auto border-l border-border" aria-label="Node details">{renderDetail()}</aside>
          </>
        )}
    </div>
    </ViewerLayout>
  );
}
