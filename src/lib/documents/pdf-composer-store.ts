/**
 * Client-side state for the PDF composition editor (.pdf.source.json files).
 * All tree edits go through the pure ops in pdf-composition.ts and are
 * re-validated — an invalid result is rejected and the previous tree kept.
 * Undo history stores whole-composition snapshots (compositions are small;
 * capped at 100).
 */
import { create } from "zustand";
import { componentSpec } from "./pdf-component-catalog";
import {
  duplicateNode,
  insertNode,
  moveNode,
  newNodeId,
  removeNode,
  updateNode,
  validateComposition,
  type JsonValue,
  type PdfComposition,
  type PdfNode,
  type TreeOpResult,
} from "./pdf-composition";

export type PdfRegion = "body" | "header" | "footer";

export type DragRef =
  | { kind: "palette"; type: string }
  | { kind: "node"; id: string };

/** Where a drop would land: `parentId` null → the region's root list. */
export interface DropTarget {
  parentId: string | null;
  region: PdfRegion;
}

export interface PreviewState {
  key: string | null;
  jobId: string | null;
  pageCount: number;
  warnings: { nodeId?: string; message: string }[];
  rendering: boolean;
  error: string | null;
}

export interface OutputStatus {
  virtualPath: string;
  revision: string;
  stale: boolean;
  modified: boolean;
}

const UNDO_CAP = 100;

interface ComposerState {
  path: string | null;
  composition: PdfComposition | null;
  selectedId: string | null;
  undoStack: PdfComposition[];
  redoStack: PdfComposition[];
  /** Merge key of the last commit — consecutive commits sharing a key count
      as one gesture (typing in an inspector field). */
  lastMergeKey: string | null;
  dirty: boolean;
  dirtyGeneration: number;
  saving: boolean;
  sourceRevision: string | null;
  status: OutputStatus | null;
  preview: PreviewState;
  /** Last rejected edit (validation failure) — surfaced as a toast/banner. */
  editError: string | null;
  /** Live drag state for the outline's zone indicators. */
  activeDrag: DragRef | null;
  dropValid: boolean;
  overZone: string | null;
  dragReason?: string;

  load: (path: string, composition: PdfComposition, revision: string) => void;
  unload: () => void;
  select: (id: string | null) => void;
  /** Apply a candidate tree: validate, push undo, mark dirty. Returns the
      rejection reason when the result would be invalid. */
  commit: (next: PdfComposition, mergeKey?: string) => string | null;
  undo: () => void;
  redo: () => void;

  insertPalette: (type: string) => string | null;
  insertTypeAt: (type: string, target: DropTarget, index: number) => string | null;
  insertNodesAt: (nodes: PdfNode[], target: DropTarget, index?: number) => string | null;
  applyOp: (op: (tree: PdfComposition) => TreeOpResult, selectId?: string) => string | null;
  updateProps: (id: string, props: Record<string, JsonValue>) => string | null;
  updateData: (id: string, data: JsonValue) => string | null;
  setHidden: (id: string, hidden: boolean) => string | null;
  remove: (id: string) => string | null;
  duplicate: (id: string) => string | null;
  move: (id: string, target: DropTarget, index: number) => string | null;
  moveBy: (id: string, delta: -1 | 1) => string | null;
  moveOut: (id: string) => string | null;
  moveIntoPrev: (id: string) => string | null;

  setDoc: (patch: Partial<Pick<PdfComposition, "title" | "page" | "theme" | "assets">>) => string | null;

  setSaving: (saving: boolean) => void;
  markSaved: (revision: string) => void;
  setSourceRevision: (revision: string) => void;
  setStatus: (status: OutputStatus | null) => void;
  setPreview: (p: Partial<PreviewState>) => void;
  setEditError: (e: string | null) => void;
  setDragState: (s: {
    drag: DragRef | null;
    valid: boolean;
    overZone: string | null;
    reason?: string;
  }) => void;
}

// ── pure helpers (exported for tests + the outline's drop logic) ────────────

function regionLists(c: PdfComposition): { region: PdfRegion; list: PdfNode[] }[] {
  return [
    { region: "body", list: c.body },
    ...(c.header ? [{ region: "header" as const, list: c.header }] : []),
    ...(c.footer ? [{ region: "footer" as const, list: c.footer }] : []),
  ];
}

/** Locate a node: its parent list, index, region and parent node id. */
export function locateIn(
  c: PdfComposition,
  id: string,
): { parentId: string | null; region: PdfRegion; index: number; node: PdfNode } | null {
  const walk = (
    list: PdfNode[],
    region: PdfRegion,
    parentId: string | null,
  ): { parentId: string | null; region: PdfRegion; index: number; node: PdfNode } | null => {
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (n.id === id) return { parentId, region, index: i, node: n };
      if (n.children) {
        const hit = walk(n.children, region, n.id);
        if (hit) return hit;
      }
    }
    return null;
  };
  for (const { region, list } of regionLists(c)) {
    const hit = walk(list, region, null);
    if (hit) return hit;
  }
  return null;
}

function findNodeById(c: PdfComposition, id: string): PdfNode | null {
  return locateIn(c, id)?.node ?? null;
}

function isDescendantOf(node: PdfNode, ancestorId: string): boolean {
  for (const child of node.children ?? []) {
    if (child.id === ancestorId || isDescendantOf(child, ancestorId)) return true;
  }
  return false;
}

function parentAccepts(parentType: string, childType: string): boolean {
  const spec = componentSpec(childType);
  if (!spec) return false;
  if (!(spec.allowedParents as readonly string[]).includes(parentType)) return false;
  if (parentType !== "body" && parentType !== "header" && parentType !== "footer") {
    return componentSpec(parentType)?.allowsChildren === true;
  }
  return true;
}

/**
 * Whether `drag` may land under `target` (parentId null = region root).
 * Covers: palette-vs-node drags, leaf targets, own-descendant targets, and
 * region rules (e.g. watermark is body-only, header/footer reject body-only
 * types via allowedParents).
 */
export function computeDropValidity(
  tree: PdfComposition,
  drag: DragRef,
  target: DropTarget,
): { ok: true } | { ok: false; reason: string } {
  let childType: string;
  if (drag.kind === "palette") {
    childType = drag.type;
    if (!componentSpec(childType)) return { ok: false, reason: `unknown type ${childType}` };
  } else {
    const hit = locateIn(tree, drag.id);
    if (!hit) return { ok: false, reason: "node not found" };
    childType = hit.node.type;
    // A node can't be dropped into itself or one of its own descendants.
    if (target.parentId) {
      if (target.parentId === drag.id || isDescendantOf(hit.node, target.parentId)) {
        return { ok: false, reason: "cannot drop into itself" };
      }
    }
  }
  const parentType = target.parentId ? findNodeById(tree, target.parentId)?.type : target.region;
  if (!parentType) return { ok: false, reason: "target parent not found" };
  if (!parentAccepts(parentType, childType)) {
    return { ok: false, reason: `"${childType}" is not allowed inside "${parentType}"` };
  }
  return { ok: true };
}

/** Re-id a subtree in place (used when inserting template node groups). */
export function reIdSubtree(node: PdfNode): void {
  node.id = newNodeId(node.type);
  node.children?.forEach(reIdSubtree);
}

/**
 * Build a fresh catalog node: defaults applied, required props seeded so the
 * new node validates immediately (users refine them in the inspector).
 */
export function buildNode(type: string): PdfNode | null {
  const spec = componentSpec(type);
  if (!spec) return null;
  const props = { ...(spec.defaults as Record<string, JsonValue> | undefined) };
  for (const [key, ps] of Object.entries(spec.props)) {
    if (!ps.required || props[key] !== undefined) continue;
    props[key] =
      ps.type === "string"
        ? key === "text" || key === "title"
          ? spec.label
          : ""
        : ps.type === "url"
          ? "https://"
          : ps.type === "asset-ref"
            ? "asset"
            : ps.type === "json"
              ? []
              : (ps.min ?? 0);
  }
  const node: PdfNode = { type, id: newNodeId(type), props };
  if (spec.data?.kind === "rows") {
    node.data = { columns: ["Column 1", "Column 2"], rows: [["", ""]] };
  } else if (spec.data?.kind === "kv") {
    node.data = { entries: [{ key: "Key", value: "Value" }] };
  } else if (spec.data?.kind === "chart") {
    node.data = { data: [{ label: "A", value: 1 }, { label: "B", value: 2 }] };
  }
  return node;
}

// ── store ───────────────────────────────────────────────────────────────────

const emptyPreview: PreviewState = {
  key: null,
  jobId: null,
  pageCount: 0,
  warnings: [],
  rendering: false,
  error: null,
};

export const usePdfComposerStore = create<ComposerState>((set, get) => ({
  path: null,
  composition: null,
  selectedId: null,
  undoStack: [],
  redoStack: [],
  lastMergeKey: null,
  dirty: false,
  dirtyGeneration: 0,
  saving: false,
  sourceRevision: null,
  status: null,
  preview: emptyPreview,
  editError: null,
  activeDrag: null,
  dropValid: true,
  overZone: null,

  load: (path, composition, revision) =>
    set({
      path,
      composition,
      selectedId: null,
      undoStack: [],
      redoStack: [],
      lastMergeKey: null,
      dirty: false,
      dirtyGeneration: 0,
      saving: false,
      sourceRevision: revision,
      status: null,
      preview: emptyPreview,
      editError: null,
    }),

  unload: () =>
    set({
      path: null,
      composition: null,
      selectedId: null,
      undoStack: [],
      redoStack: [],
      lastMergeKey: null,
      dirty: false,
      saving: false,
      sourceRevision: null,
      status: null,
      preview: emptyPreview,
      editError: null,
    }),

  select: (id) => set({ selectedId: id }),

  commit: (next, mergeKey) => {
    const s = get();
    if (!s.composition) return "no composition loaded";
    const validated = validateComposition(next);
    if (!validated.ok) {
      const reason = validated.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
      set({ editError: reason });
      return reason;
    }
    const merge = mergeKey !== undefined && mergeKey === s.lastMergeKey;
    set({
      composition: validated.value,
      dirty: true,
      dirtyGeneration: s.dirtyGeneration + 1,
      undoStack: merge
        ? s.undoStack
        : [...s.undoStack.slice(-(UNDO_CAP - 1)), s.composition],
      redoStack: [],
      lastMergeKey: mergeKey ?? null,
      editError: null,
    });
    return null;
  },

  undo: () => {
    const s = get();
    const prev = s.undoStack[s.undoStack.length - 1];
    if (!prev || !s.composition) return;
    set({
      composition: prev,
      undoStack: s.undoStack.slice(0, -1),
      redoStack: [...s.redoStack, s.composition],
      lastMergeKey: null,
      dirty: true,
      dirtyGeneration: s.dirtyGeneration + 1,
      selectedId: s.selectedId && locateIn(prev, s.selectedId) ? s.selectedId : null,
    });
  },

  redo: () => {
    const s = get();
    const next = s.redoStack[s.redoStack.length - 1];
    if (!next || !s.composition) return;
    set({
      composition: next,
      redoStack: s.redoStack.slice(0, -1),
      undoStack: [...s.undoStack.slice(-(UNDO_CAP - 1)), s.composition],
      lastMergeKey: null,
      dirty: true,
      dirtyGeneration: s.dirtyGeneration + 1,
    });
  },

  applyOp: (op, selectId) => {
    const s = get();
    if (!s.composition) return "no composition loaded";
    const res = op(s.composition);
    if (!res.ok) {
      set({ editError: res.error });
      return res.error;
    }
    const err = s.commit(res.tree);
    if (!err && selectId !== undefined) set({ selectedId: selectId });
    return err;
  },

  insertPalette: (type) => {
    const s = get();
    const c = s.composition;
    if (!c) return "no composition loaded";
    const node = buildNode(type);
    if (!node) return `unknown type ${type}`;
    // Into the selected container when it accepts the type, otherwise after
    // the selected block, otherwise at the end of the body.
    if (s.selectedId) {
      const sel = locateIn(c, s.selectedId);
      if (sel) {
        const selSpec = componentSpec(sel.node.type);
        if (selSpec?.allowsChildren && parentAccepts(sel.node.type, type)) {
          return s.applyOp(
            (t) => insertNode(t, sel.node.id, sel.node.children?.length ?? 0, node),
            node.id,
          );
        }
        const target: DropTarget = { parentId: sel.parentId, region: sel.region };
        if (computeDropValidity(c, { kind: "palette", type }, target).ok) {
          return s.applyOp(
            (t) => insertNode(t, sel.parentId, sel.index + 1, node, sel.region),
            node.id,
          );
        }
      }
    }
    const target: DropTarget = { parentId: null, region: "body" };
    if (!computeDropValidity(c, { kind: "palette", type }, target).ok) {
      const reason = `"${type}" is not allowed in the body`;
      set({ editError: reason });
      return reason;
    }
    return s.applyOp((t) => insertNode(t, null, t.body.length, node), node.id);
  },

  insertTypeAt: (type, target, index) => {
    const s = get();
    const c = s.composition;
    if (!c) return "no composition loaded";
    const node = buildNode(type);
    if (!node) return `unknown type ${type}`;
    const validity = computeDropValidity(c, { kind: "palette", type }, target);
    if (!validity.ok) {
      set({ editError: validity.reason });
      return validity.reason;
    }
    return s.applyOp(
      (t) => insertNode(t, target.parentId, index, node, target.region),
      node.id,
    );
  },

  insertNodesAt: (nodes, target, index) => {
    const s = get();
    const c = s.composition;
    if (!c) return "no composition loaded";
    const clones = nodes.map((n) => {
      const copy = structuredClone(n);
      reIdSubtree(copy);
      return copy;
    });
    let tree = c;
    let at = index ?? 0;
    for (const node of clones) {
      const validity = computeDropValidity(tree, { kind: "palette", type: node.type }, target);
      if (!validity.ok) {
        set({ editError: validity.reason });
        return validity.reason;
      }
      const res = insertNode(tree, target.parentId, at, node, target.region);
      if (!res.ok) {
        set({ editError: res.error });
        return res.error;
      }
      tree = res.tree;
      at++;
    }
    const first = clones[0]?.id;
    const err = s.commit(tree);
    if (!err && first) set({ selectedId: first });
    return err;
  },

  updateProps: (id, props) => {
    const s = get();
    if (!s.composition) return "no composition loaded";
    const res = updateNode(s.composition, id, { props });
    if (!res.ok) return res.error;
    return s.commit(res.tree, `props:${id}:${Object.keys(props).sort().join(",")}`);
  },

  updateData: (id, data) => {
    const s = get();
    if (!s.composition) return "no composition loaded";
    const res = updateNode(s.composition, id, { data });
    if (!res.ok) return res.error;
    return s.commit(res.tree, `data:${id}`);
  },

  setHidden: (id, hidden) => {
    const s = get();
    if (!s.composition) return "no composition loaded";
    const res = updateNode(s.composition, id, { hidden });
    if (!res.ok) return res.error;
    return s.commit(res.tree);
  },

  remove: (id) => {
    const s = get();
    return s.applyOp((t) => removeNode(t, id), undefined);
  },

  duplicate: (id) => {
    const s = get();
    if (!s.composition) return "no composition loaded";
    const res = duplicateNode(s.composition, id);
    if (!res.ok) {
      set({ editError: res.error });
      return res.error;
    }
    const err = s.commit(res.tree);
    if (!err) {
      // The duplicate sits right after the original; find it by index.
      const loc = locateIn(res.tree, id);
      if (loc) {
        const list = loc.parentId
          ? findNodeById(res.tree, loc.parentId)?.children ?? []
          : res.tree[loc.region === "body" ? "body" : loc.region]!;
        const dup = list[loc.index + 1];
        if (dup) set({ selectedId: dup.id });
      }
    }
    return err;
  },

  move: (id, target, index) => {
    const s = get();
    if (!s.composition) return "no composition loaded";
    const validity = computeDropValidity(s.composition, { kind: "node", id }, target);
    if (!validity.ok) {
      set({ editError: validity.reason });
      return validity.reason;
    }
    return s.applyOp((t) => moveNode(t, id, target.parentId, index, target.region), id);
  },

  moveBy: (id, delta) => {
    const s = get();
    const c = s.composition;
    if (!c) return "no composition loaded";
    const loc = locateIn(c, id);
    if (!loc) return "node not found";
    return s.applyOp(
      (t) => moveNode(t, id, loc.parentId, loc.index + delta, loc.region),
      id,
    );
  },

  moveOut: (id) => {
    const s = get();
    const c = s.composition;
    if (!c) return "no composition loaded";
    const loc = locateIn(c, id);
    if (!loc || !loc.parentId) return "already at root";
    const parentLoc = locateIn(c, loc.parentId)!;
    return s.applyOp(
      (t) => moveNode(t, id, parentLoc.parentId, parentLoc.index + 1, parentLoc.region),
      id,
    );
  },

  moveIntoPrev: (id) => {
    const s = get();
    const c = s.composition;
    if (!c) return "no composition loaded";
    const loc = locateIn(c, id);
    if (!loc || loc.index === 0) return "no previous sibling";
    const list = loc.parentId
      ? findNodeById(c, loc.parentId)?.children ?? []
      : c[loc.region === "body" ? "body" : loc.region]!;
    const prev = list[loc.index - 1];
    if (!prev || componentSpec(prev.type)?.allowsChildren !== true) {
      const reason = "previous sibling is not a container";
      set({ editError: reason });
      return reason;
    }
    const target: DropTarget = { parentId: prev.id, region: loc.region };
    const validity = computeDropValidity(c, { kind: "node", id }, target);
    if (!validity.ok) {
      set({ editError: validity.reason });
      return validity.reason;
    }
    return s.applyOp(
      (t) => moveNode(t, id, prev.id, prev.children?.length ?? 0, loc.region),
      id,
    );
  },

  setDoc: (patch) => {
    const s = get();
    if (!s.composition) return "no composition loaded";
    return s.commit({ ...structuredClone(s.composition), ...patch }, "doc");
  },

  setSaving: (saving) => set({ saving }),
  markSaved: (revision) =>
    set({ sourceRevision: revision, dirty: false, saving: false, lastMergeKey: null }),
  setSourceRevision: (revision) => set({ sourceRevision: revision }),
  setStatus: (status) => set({ status }),
  setPreview: (p) => set({ preview: { ...get().preview, ...p } }),
  setEditError: (e) => set({ editError: e }),
  setDragState: (s) =>
    set({ activeDrag: s.drag, dropValid: s.valid, overZone: s.overZone, dragReason: s.reason }),
}));
