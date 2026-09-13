"use client";

/**
 * Center pane of the PDF composer: the nested block outline.
 *
 * Drag model: rows are `useDraggable`; drop targets are dedicated thin
 * "zone" rows rendered before every sibling inside every list (including
 * header/footer roots and empty containers — zone 0 inside a container is
 * how "drop into" works). Validity is computed against the catalog during
 * onDragOver so invalid targets light up red and onDragEnd no-ops.
 */
import { useMemo, useState } from "react";
import {
  DndContext,
  MeasuringStrategy,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  MoreHorizontal,
  Trash2,
  ArrowUp,
  ArrowDown,
  LogIn,
  LogOut,
} from "lucide-react";

import type { PdfNode } from "@/lib/documents/pdf-composition";
import { componentSpec } from "@/lib/documents/pdf-component-catalog";
import {
  computeDropValidity,
  locateIn,
  usePdfComposerStore,
  type DragRef,
  type DropTarget,
  type PdfRegion,
} from "@/lib/documents/pdf-composer-store";
import { useLocale } from "@/i18n/use-locale";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { catalogIcon, GripVertical } from "./icons";
import { componentLabel } from "./labels";

function toast(kind: "success" | "error" | "info", message: string) {
  window.dispatchEvent(new CustomEvent("cabinet:toast", { detail: { kind, message } }));
}

interface ZoneId {
  region: PdfRegion;
  parentId: string | null;
  index: number;
}

function zoneId(z: ZoneId): string {
  return `zone:${z.region}:${z.parentId ?? "root"}:${z.index}`;
}


function nodeSummary(node: PdfNode): string {
  const p = node.props ?? {};
  const text = typeof p.text === "string" ? p.text : typeof p.title === "string" ? p.title : "";
  if (text) return text.slice(0, 40);
  if (node.data && typeof node.data === "object" && !Array.isArray(node.data)) {
    const d = node.data as Record<string, unknown>;
    if (Array.isArray(d.rows)) return `${d.rows.length} rows`;
    if (Array.isArray(d.entries)) return `${d.entries.length} entries`;
    if (Array.isArray(d.data)) return `${d.data.length} points`;
  }
  return "";
}

// ── drop zone ────────────────────────────────────────────────────────────────

function DropZone({
  zone,
  depth,
  drag,
  valid,
  overId,
}: {
  zone: ZoneId;
  depth: number;
  drag: DragRef | null;
  valid: boolean;
  overId: string | null;
}) {
  const id = zoneId(zone);
  const { setNodeRef, isOver } = useDroppable({ id, data: zone });
  const active = isOver && overId === id;
  return (
    <div
      ref={setNodeRef}
      data-zone-id={id}
      className={cn(
        "relative transition-all",
        drag ? "h-3" : "h-0.5",
      )}
      style={{ marginInlineStart: depth * 14 }}
    >
      <div
        className={cn(
          "absolute inset-x-1 top-1/2 h-0.5 -translate-y-1/2 rounded-full",
          active && (valid ? "bg-emerald-500" : "bg-red-500"),
          !active && isOver && "bg-muted",
        )}
      />
    </div>
  );
}

// ── row ──────────────────────────────────────────────────────────────────────

function OutlineRow({
  node,
  depth,
  region,
  onRemoved,
}: {
  node: PdfNode;
  depth: number;
  region: PdfRegion;
  onRemoved: () => void;
}) {
  const { t } = useLocale();
  const selectedId = usePdfComposerStore((s) => s.selectedId);
  const select = usePdfComposerStore((s) => s.select);
  const setHidden = usePdfComposerStore((s) => s.setHidden);
  const duplicate = usePdfComposerStore((s) => s.duplicate);
  const remove = usePdfComposerStore((s) => s.remove);
  const moveBy = usePdfComposerStore((s) => s.moveBy);
  const moveOut = usePdfComposerStore((s) => s.moveOut);
  const moveIntoPrev = usePdfComposerStore((s) => s.moveIntoPrev);
  const [open, setOpen] = useState(true);

  const spec = componentSpec(node.type);
  const Icon = catalogIcon(spec?.icon ?? "");
  const selected = selectedId === node.id;
  const hasChildren = Boolean(spec?.allowsChildren);

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `node-${node.id}`,
    data: { kind: "node", id: node.id },
  });

  const loc = useMemo(
    () => locateIn(usePdfComposerStore.getState().composition!, node.id),
    // re-locate on every render — tree identity changes per commit.
    [node.id],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.altKey && e.key === "ArrowUp") {
      e.preventDefault();
      moveBy(node.id, -1);
      requestAnimationFrame(() => focusRow(node.id));
    } else if (e.altKey && e.key === "ArrowDown") {
      e.preventDefault();
      moveBy(node.id, 1);
      requestAnimationFrame(() => focusRow(node.id));
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
      e.preventDefault();
      duplicate(node.id);
      requestAnimationFrame(() => {
        const sel = usePdfComposerStore.getState().selectedId;
        if (sel) focusRow(sel);
      });
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      const err = remove(node.id);
      if (!err) {
        toast("info", t("pdfComposer:removedUndo"));
        onRemoved();
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent("pdfcomposer:focus-inspector"));
    }
  };

  return (
    <div>
      <div
        ref={setNodeRef}
        role="treeitem"
        aria-selected={selected}
        tabIndex={0}
        data-node-id={node.id}
        onKeyDown={onKeyDown}
        onClick={() => select(node.id)}
        className={cn(
          "group flex select-none items-center gap-1 rounded-md px-1 py-0.5 text-xs outline-none transition-colors",
          selected ? "bg-primary/10 ring-1 ring-primary/30" : "hover:bg-accent/60",
          isDragging && "opacity-40",
          node.hidden && "opacity-50",
        )}
        style={{ marginInlineStart: depth * 14 }}
      >
        <button
          type="button"
          className="cursor-grab touch-none text-muted-foreground/40 hover:text-muted-foreground active:cursor-grabbing"
          aria-label={t("pdfComposer:dragHandle")}
          {...listeners}
          {...attributes}
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className={cn("text-muted-foreground/50", !hasChildren && "invisible")}
          onClick={(e) => {
            e.stopPropagation();
            setOpen(!open);
          }}
          aria-label={open ? t("pdfComposer:collapse") : t("pdfComposer:expand")}
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium" title={spec ? componentLabel(t, spec.type, spec.label) : node.type}>
          {spec ? componentLabel(t, spec.type, spec.label) : node.type}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground/60">{nodeSummary(node)}</span>
        <button
          type="button"
          className="invisible text-muted-foreground/50 hover:text-foreground group-hover:visible"
          aria-label={node.hidden ? t("pdfComposer:show") : t("pdfComposer:hide")}
          onClick={(e) => {
            e.stopPropagation();
            setHidden(node.id, !node.hidden);
          }}
        >
          {node.hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger
            className="invisible text-muted-foreground/50 hover:text-foreground group-hover:visible"
            aria-label={t("pdfComposer:rowMenu")}
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => duplicate(node.id)}>
              <Copy className="mr-2 h-3.5 w-3.5" /> {t("pdfComposer:duplicate")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                moveBy(node.id, -1);
                requestAnimationFrame(() => focusRow(node.id));
              }}
            >
              <ArrowUp className="mr-2 h-3.5 w-3.5" /> {t("pdfComposer:moveUp")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                moveBy(node.id, 1);
                requestAnimationFrame(() => focusRow(node.id));
              }}
            >
              <ArrowDown className="mr-2 h-3.5 w-3.5" /> {t("pdfComposer:moveDown")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!loc || loc.index === 0}
              onClick={() => {
                const err = moveIntoPrev(node.id);
                if (err) toast("error", err);
                else requestAnimationFrame(() => focusRow(node.id));
              }}
            >
              <LogIn className="mr-2 h-3.5 w-3.5" /> {t("pdfComposer:moveInto")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!loc?.parentId}
              onClick={() => {
                moveOut(node.id);
                requestAnimationFrame(() => focusRow(node.id));
              }}
            >
              <LogOut className="mr-2 h-3.5 w-3.5" /> {t("pdfComposer:moveOut")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive"
              onClick={() => {
                const err = remove(node.id);
                if (!err) {
                  toast("info", t("pdfComposer:removedUndo"));
                  onRemoved();
                }
              }}
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" /> {t("pdfComposer:delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {hasChildren && open && (
        <NodeList
          nodes={node.children ?? []}
          depth={depth + 1}
          region={region}
          parentId={node.id}
          onRemoved={onRemoved}
        />
      )}
    </div>
  );
}

function focusRow(id: string) {
  document.querySelector(`[data-node-id="${id}"]`)?.dispatchEvent?.(new FocusEvent("focus"));
  (document.querySelector(`[data-node-id="${id}"]`) as HTMLElement | null)?.focus();
}

function NodeList({
  nodes,
  depth,
  region,
  parentId,
  onRemoved,
}: {
  nodes: PdfNode[];
  depth: number;
  region: PdfRegion;
  parentId: string | null;
  onRemoved: () => void;
}) {
  const { t } = useLocale();
  const drag = usePdfComposerStore((s) => s.activeDrag);
  const dropValid = usePdfComposerStore((s) => s.dropValid);
  const overZone = usePdfComposerStore((s) => s.overZone);
  return (
    <div role="group">
      <DropZone zone={{ region, parentId, index: 0 }} depth={depth} drag={drag} valid={dropValid} overId={overZone} />
      {nodes.length === 0 && (
        <div
          className="select-none px-2 py-1 text-[10px] italic text-muted-foreground/40"
          style={{ marginInlineStart: depth * 14 }}
        >
          {t("pdfComposer:emptyList")}
        </div>
      )}
      {nodes.map((n, i) => (
        <div key={n.id}>
          <OutlineRow node={n} depth={depth} region={region} onRemoved={onRemoved} />
          <DropZone
            zone={{ region, parentId, index: i + 1 }}
            depth={depth}
            drag={drag}
            valid={dropValid}
            overId={overZone}
          />
        </div>
      ))}
    </div>
  );
}

function RegionBlock({
  title,
  region,
  nodes,
  onRemoved,
}: {
  title: string;
  region: PdfRegion;
  nodes: PdfNode[] | undefined;
  onRemoved: () => void;
}) {
  const [open, setOpen] = useState(region === "body");
  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full select-none items-center gap-1.5 px-1 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {title}
      </button>
      {open && (
        <NodeList nodes={nodes ?? []} depth={0} region={region} parentId={null} onRemoved={onRemoved} />
      )}
    </div>
  );
}

/**
 * DndContext for the whole composer — it must wrap BOTH the palette (drag
 * sources) and the outline (drop zones), so it lives one level above the
 * panes and the handlers talk to the store.
 */
export function ComposerDnd({ children }: { children: React.ReactNode }) {
  const { t } = useLocale();
  const setDragState = usePdfComposerStore((s) => s.setDragState);
  const insertTypeAt = usePdfComposerStore((s) => s.insertTypeAt);
  const move = usePdfComposerStore((s) => s.move);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragStart = (e: DragStartEvent) => {
    // Pointer drags over text would otherwise leave a stray selection behind.
    window.getSelection()?.removeAllRanges();
    setDragState({ drag: (e.active.data.current as DragRef) ?? null, valid: true, overZone: null });
  };

  const onDragOver = (e: DragOverEvent) => {
    const drag = (e.active.data.current as DragRef) ?? null;
    const zone = e.over?.data.current as ZoneId | undefined;
    if (!drag || !zone) {
      setDragState({ drag, valid: true, overZone: null });
      return;
    }
    const validity = computeDropValidity(
      usePdfComposerStore.getState().composition!,
      drag,
      { parentId: zone.parentId, region: zone.region },
    );
    setDragState({
      drag,
      valid: validity.ok,
      overZone: zoneId(zone),
      reason: validity.ok ? undefined : validity.reason,
    });
  };

  const onDragEnd = (e: DragEndEvent) => {
    const drag = (e.active.data.current as DragRef) ?? null;
    const zone = e.over?.data.current as ZoneId | undefined;
    setDragState({ drag: null, valid: true, overZone: null });
    if (!drag || !zone) return;
    const target: DropTarget = { parentId: zone.parentId, region: zone.region };
    const err =
      drag.kind === "palette"
        ? insertTypeAt(drag.type, target, zone.index)
        : move(drag.id, target, zone.index);
    if (err) toast("error", err);
    else if (drag.kind === "node") requestAnimationFrame(() => focusRow(drag.id));
  };

  return (
    <DndContext
      sensors={sensors}
      // Zones expand from 2px to 12px when a drag starts, shifting every
      // droppable rect — re-measure continuously so hit tests stay correct.
      measuring={{ droppable: { strategy: MeasuringStrategy.WhileDragging } }}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragState({ drag: null, valid: true, overZone: null })}
      accessibility={{
        announcements: {
          onDragStart: ({ active }) =>
            t("pdfComposer:dndStart", { id: String(active.id) }),
          onDragOver: ({ over }) =>
            over ? t("pdfComposer:dndOver", { id: String(over.id) }) : undefined,
          onDragEnd: ({ over }) =>
            over ? t("pdfComposer:dndEnd", { id: String(over.id) }) : undefined,
          onDragCancel: () => t("pdfComposer:dndCancel"),
        },
      }}
    >
      {children}
    </DndContext>
  );
}

export function ComposerOutline() {
  const { t } = useLocale();
  const composition = usePdfComposerStore((s) => s.composition);
  const setEditError = usePdfComposerStore((s) => s.setEditError);
  const editError = usePdfComposerStore((s) => s.editError);

  if (!composition) return null;

  const onRemoved = () => {
    /* undo is the recovery path — the toast announces it */
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="pdf-outline">
      {editError && (
        <div className="mx-2 mt-2 flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          <span className="truncate">{editError}</span>
          <button type="button" onClick={() => setEditError(null)} aria-label="dismiss">
            ×
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-2" role="tree">
        <RegionBlock
          title={t("pdfComposer:regionHeader")}
          region="header"
          nodes={composition.header}
          onRemoved={onRemoved}
        />
        <RegionBlock
          title={t("pdfComposer:regionBody")}
          region="body"
          nodes={composition.body}
          onRemoved={onRemoved}
        />
        <RegionBlock
          title={t("pdfComposer:regionFooter")}
          region="footer"
          nodes={composition.footer}
          onRemoved={onRemoved}
        />
      </div>
    </div>
  );
}
