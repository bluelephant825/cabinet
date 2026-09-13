/**
 * .pdf.source.json composition model: schema, validation, and pure tree
 * operations shared by the render service, the (future) editor UI, and agent
 * tooling. A composition is the ONLY input the PDF generator accepts — it is
 * fully declarative (no code, no eval) and catalog-checked.
 */
import {
  PDFCN_CATALOG_VERSION,
  componentSpec,
  isPdfThemeId,
  type PdfComponentSpec,
  type PdfPropSpec,
} from "./pdf-component-catalog";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export interface PdfNode {
  type: string;
  id: string;
  props?: Record<string, JsonValue>;
  data?: JsonValue;
  children?: PdfNode[];
  hidden?: boolean;
}

export interface PdfComposition {
  schemaVersion: 1;
  documentId: string;
  catalogVersion: string;
  title?: string;
  page: {
    size: "A4" | "Letter" | "Legal" | { widthPt: number; heightPt: number };
    orientation: "portrait" | "landscape";
    margins: { top: number; right: number; bottom: number; left: number };
  };
  theme: string;
  header?: PdfNode[];
  footer?: PdfNode[];
  body: PdfNode[];
  assets?: Record<string, { path: string; sha256?: string }>;
}

// ── limits ────────────────────────────────────────────────────────────────
const MAX_DEPTH = 12;
const MAX_NODES = 2000;
const MAX_TABLE_ROWS = 5000;
const MAX_TABLE_CELLS = 50_000;
const MAX_STRING = 20_000;
const MAX_DATA_URL = 2 * 1024 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface CompositionError {
  path: string;
  code:
    | "shape"
    | "unknown-type"
    | "invalid-id"
    | "duplicate-id"
    | "bad-prop"
    | "bad-data"
    | "bad-parent"
    | "too-deep"
    | "too-large"
    | "bad-link"
    | "bad-asset"
    | "unsupported";
  message: string;
}

export type ValidationResult =
  | { ok: true; value: PdfComposition }
  | { ok: false; errors: CompositionError[] };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const err = (path: string, code: CompositionError["code"], message: string): CompositionError => ({
  path,
  code,
  message,
});

const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const NAMED_COLORS = new Set([
  "black", "white", "red", "green", "blue", "gray", "grey", "orange", "yellow",
  "purple", "pink", "brown", "transparent", "currentcolor",
]);

function isLinkAllowed(href: string): boolean {
  if (/^(https|mailto):/i.test(href)) return true;
  // In-cabinet relative path: no scheme, no drive letter, no traversal.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return false;
  return !href.split("/").includes("..");
}

function checkProp(
  spec: PdfPropSpec,
  value: JsonValue,
  path: string,
  errors: CompositionError[],
): void {
  switch (spec.type) {
    case "string":
      if (typeof value !== "string") {
        errors.push(err(path, "bad-prop", "expected a string"));
      } else if (value.length > MAX_STRING) {
        errors.push(err(path, "too-large", `string exceeds ${MAX_STRING} chars`));
      }
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        errors.push(err(path, "bad-prop", "expected a number"));
      } else {
        if (spec.min !== undefined && value < spec.min) errors.push(err(path, "bad-prop", `below min ${spec.min}`));
        if (spec.max !== undefined && value > spec.max) errors.push(err(path, "bad-prop", `above max ${spec.max}`));
        if (spec.enum && !spec.enum.includes(String(value))) {
          errors.push(err(path, "bad-prop", `must be one of ${spec.enum.join("/")}`));
        }
      }
      break;
    case "length-pt":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        errors.push(err(path, "bad-prop", "expected a point length (number)"));
      } else {
        if (spec.min !== undefined && value < spec.min) errors.push(err(path, "bad-prop", `below min ${spec.min}pt`));
        if (spec.max !== undefined && value > spec.max) errors.push(err(path, "bad-prop", `above max ${spec.max}pt`));
      }
      break;
    case "boolean":
      if (typeof value !== "boolean") errors.push(err(path, "bad-prop", "expected a boolean"));
      break;
    case "color":
      if (typeof value !== "string" || (!COLOR_RE.test(value) && !NAMED_COLORS.has(value.toLowerCase()))) {
        errors.push(err(path, "bad-prop", "expected #rgb/#rrggbb or a basic color name"));
      }
      break;
    case "url":
      if (typeof value !== "string" || !isLinkAllowed(value)) {
        errors.push(err(path, "bad-link", "links must be https:, mailto:, or an in-cabinet path"));
      }
      break;
    case "asset-ref":
      if (typeof value !== "string" || !ID_RE.test(value)) {
        errors.push(err(path, "bad-asset", "asset must be a key into composition.assets"));
      }
      break;
    case "json":
      if (value === undefined) {
        if (spec.required) errors.push(err(path, "bad-prop", "required"));
        break;
      }
      if (JSON.stringify(value).length > MAX_TABLE_CELLS * 40) {
        errors.push(err(path, "too-large", "json payload too large"));
      }
      break;
  }
}

function checkData(
  spec: PdfComponentSpec,
  node: PdfNode,
  path: string,
  errors: CompositionError[],
): void {
  if (!spec.data) return;
  const d = node.data;
  switch (spec.data.kind) {
    case "rows": {
      if (!isObj(d) || !Array.isArray(d.columns) || !Array.isArray(d.rows)) {
        errors.push(err(path, "bad-data", "table data must be {columns:[string], rows:[[cells]]}"));
        return;
      }
      if ((d.rows as unknown[]).length > MAX_TABLE_ROWS) {
        errors.push(err(path, "too-large", `table exceeds ${MAX_TABLE_ROWS} rows`));
      }
      let cells = 0;
      for (const row of d.rows as unknown[]) {
        if (!Array.isArray(row)) {
          errors.push(err(path, "bad-data", "each row must be an array"));
          return;
        }
        cells += row.length;
      }
      if (cells > MAX_TABLE_CELLS) errors.push(err(path, "too-large", `table exceeds ${MAX_TABLE_CELLS} cells`));
      break;
    }
    case "chart": {
      const points = (d as { data?: unknown })?.data ?? d;
      if (!Array.isArray(points)) {
        errors.push(err(path, "bad-data", "chart data must be an array of {label,value} or series"));
        return;
      }
      if (points.length > 5000) errors.push(err(path, "too-large", "chart data exceeds 5000 points"));
      break;
    }
    case "kv": {
      if (!isObj(d) || !Array.isArray(d.entries)) {
        errors.push(err(path, "bad-data", "key-value data must be {entries:[{key,value}]}"));
        return;
      }
      if ((d.entries as unknown[]).length > 2000) {
        errors.push(err(path, "too-large", "key-value exceeds 2000 entries"));
      }
      break;
    }
  }
}

export function validateComposition(input: unknown): ValidationResult {
  const errors: CompositionError[] = [];
  if (!isObj(input)) {
    return { ok: false, errors: [err("$", "shape", "composition must be an object")] };
  }
  const c = input as Record<string, unknown>;
  if (c.schemaVersion !== 1) errors.push(err("$.schemaVersion", "unsupported", "schemaVersion must be 1"));
  if (typeof c.documentId !== "string" || !ID_RE.test(c.documentId)) {
    errors.push(err("$.documentId", "invalid-id", "documentId must match ^[a-z0-9][a-z0-9-]{0,63}$"));
  }
  if (typeof c.catalogVersion !== "string" || !c.catalogVersion) {
    errors.push(err("$.catalogVersion", "shape", "catalogVersion is required"));
  }
  if (c.title !== undefined && typeof c.title !== "string") {
    errors.push(err("$.title", "shape", "title must be a string"));
  }
  if (!isObj(c.page)) {
    errors.push(err("$.page", "shape", "page is required"));
  } else {
    const p = c.page;
    const sizeOk =
      p.size === "A4" || p.size === "Letter" || p.size === "Legal" ||
      (isObj(p.size) &&
        typeof p.size.widthPt === "number" && p.size.widthPt > 0 && p.size.widthPt <= 2000 &&
        typeof p.size.heightPt === "number" && p.size.heightPt > 0 && p.size.heightPt <= 2000);
    if (!sizeOk) errors.push(err("$.page.size", "bad-prop", "size must be A4/Letter/Legal or {widthPt,heightPt}"));
    if (p.orientation !== "portrait" && p.orientation !== "landscape") {
      errors.push(err("$.page.orientation", "bad-prop", "orientation must be portrait|landscape"));
    }
    if (!isObj(p.margins)) {
      errors.push(err("$.page.margins", "shape", "margins required"));
    } else {
      for (const side of ["top", "right", "bottom", "left"] as const) {
        const v = p.margins[side];
        if (typeof v !== "number" || v < 0 || v > 400) {
          errors.push(err(`$.page.margins.${side}`, "bad-prop", "margin must be 0-400pt"));
        }
      }
    }
  }
  if (typeof c.theme !== "string" || !isPdfThemeId(c.theme)) {
    errors.push(err("$.theme", "bad-prop", "unknown theme"));
  }
  if (c.assets !== undefined) {
    if (!isObj(c.assets)) {
      errors.push(err("$.assets", "shape", "assets must be an object"));
    } else {
      for (const [k, v] of Object.entries(c.assets)) {
        if (!ID_RE.test(k)) errors.push(err(`$.assets.${k}`, "invalid-id", "asset key must be an id"));
        if (!isObj(v) || typeof v.path !== "string" || v.path.split("/").includes("..") || v.path.startsWith("/") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v.path)) {
          errors.push(err(`$.assets.${k}`, "bad-asset", "asset path must be a relative in-cabinet path"));
        }
        if (isObj(v) && v.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(String(v.sha256))) {
          errors.push(err(`$.assets.${k}.sha256`, "bad-asset", "sha256 must be 64 hex chars"));
        }
      }
    }
  }
  if (!Array.isArray(c.body)) {
    errors.push(err("$.body", "shape", "body must be an array of nodes"));
  }

  const ids = new Set<string>();
  let nodeCount = 0;
  const walkNodes = (nodes: unknown, parentChain: string[], depth: number, path: string): void => {
    if (!Array.isArray(nodes)) return;
    for (let i = 0; i < nodes.length; i++) {
      const np = `${path}[${i}]`;
      const n = nodes[i];
      if (!isObj(n)) {
        errors.push(err(np, "shape", "node must be an object"));
        continue;
      }
      nodeCount++;
      if (nodeCount > MAX_NODES) {
        errors.push(err(np, "too-large", `composition exceeds ${MAX_NODES} nodes`));
        return;
      }
      if (depth > MAX_DEPTH) {
        errors.push(err(np, "too-deep", `nesting exceeds ${MAX_DEPTH}`));
        continue;
      }
      if (typeof n.type !== "string") {
        errors.push(err(np, "unknown-type", "node.type is required"));
        continue;
      }
      const spec = componentSpec(n.type);
      if (!spec) {
        errors.push(err(np, "unknown-type", `unknown component type "${n.type}"`));
        continue;
      }
      const parent = parentChain[parentChain.length - 1] ?? "body";
      const allowedParent =
        (parentChain.length === 0 && (spec.allowedParents as readonly string[]).includes(parent)) ||
        (spec.allowedParents as readonly string[]).includes(parent);
      if (!allowedParent) {
        errors.push(err(np, "bad-parent", `"${n.type}" is not allowed inside "${parent}"`));
      }
      if (typeof n.id !== "string" || !ID_RE.test(n.id)) {
        errors.push(err(`${np}.id`, "invalid-id", "id must match ^[a-z0-9][a-z0-9-]{0,63}$"));
      } else if (ids.has(n.id)) {
        errors.push(err(`${np}.id`, "duplicate-id", `duplicate id "${n.id}"`));
      } else {
        ids.add(n.id);
      }
      if (n.hidden !== undefined && typeof n.hidden !== "boolean") {
        errors.push(err(`${np}.hidden`, "shape", "hidden must be boolean"));
      }
      // props
      for (const [key, spec2] of Object.entries(spec.props)) {
        if (spec2.required && (!isObj(n.props) || n.props[key] === undefined)) {
          errors.push(err(`${np}.props.${key}`, "bad-prop", `${key} is required`));
        }
      }
      if (n.props !== undefined) {
        if (!isObj(n.props)) {
          errors.push(err(`${np}.props`, "shape", "props must be an object"));
        } else {
          for (const [key, value] of Object.entries(n.props)) {
            const pp = `${np}.props.${key}`;
            if (key.startsWith("on")) {
              errors.push(err(pp, "bad-prop", "event-handler props are not allowed"));
              continue;
            }
            const spec2 = spec.props[key];
            if (!spec2) {
              errors.push(err(pp, "bad-prop", `unknown prop "${key}" for ${n.type}`));
              continue;
            }
            checkProp(spec2, value as JsonValue, pp, errors);
          }
          // data URLs: only allowed as *asset* image bytes via assets refs —
          // ban inline data: payloads over the cap outright.
          for (const [key, value] of Object.entries(n.props)) {
            if (typeof value === "string" && value.startsWith("data:") && value.length > MAX_DATA_URL) {
              errors.push(err(`${np}.props.${key}`, "too-large", "inline data: payload exceeds 2MB"));
            }
          }
        }
      }
      checkData(spec, n as unknown as PdfNode, `${np}.data`, errors);
      if (n.children !== undefined) {
        if (!spec.allowsChildren) {
          errors.push(err(np, "bad-parent", `"${n.type}" cannot contain children`));
        } else if (!Array.isArray(n.children)) {
          errors.push(err(`${np}.children`, "shape", "children must be an array"));
        } else {
          walkNodes(n.children, [...parentChain, n.type], depth + 1, `${np}.children`);
        }
      }
    }
  };
  walkNodes(c.body, [], 1, "$.body");
  if (c.header !== undefined) walkNodes(c.header, ["header"], 1, "$.header");
  if (c.footer !== undefined) walkNodes(c.footer, ["footer"], 1, "$.footer");

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: c as unknown as PdfComposition };
}

export function migrateComposition(input: unknown): unknown {
  // v1 passthrough — the seam for future schema versions.
  return input;
}

let counter = 0;
export function newNodeId(type: string): string {
  counter = (counter + 1) % 36 ** 4;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${type}-${Date.now().toString(36)}${counter.toString(36)}${rand}`.slice(0, 63);
}

export function newComposition(options: {
  documentId?: string;
  theme?: string;
  template?: PdfComposition;
} = {}): PdfComposition {
  if (options.template) return structuredClone(options.template);
  return {
    schemaVersion: 1,
    documentId: options.documentId ?? newNodeId("doc"),
    catalogVersion: PDFCN_CATALOG_VERSION,
    page: {
      size: "A4",
      orientation: "portrait",
      margins: { top: 56, right: 48, bottom: 56, left: 48 },
    },
    theme: options.theme ?? "professional",
    body: [],
  };
}

// ── tree ops (pure) ─────────────────────────────────────────────────────────

function findNode(nodes: PdfNode[], id: string): { node: PdfNode; parent: PdfNode[]; index: number } | null {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].id === id) return { node: nodes[i], parent: nodes, index: i };
    const hit = nodes[i].children ? findNode(nodes[i].children!, id) : null;
    if (hit) return hit;
  }
  return null;
}

function allLists(c: PdfComposition): PdfNode[][] {
  return [c.body, ...(c.header ? [c.header] : []), ...(c.footer ? [c.footer] : [])];
}

function locate(c: PdfComposition, id: string) {
  for (const list of allLists(c)) {
    const hit = findNode(list, id);
    if (hit) return hit;
  }
  return null;
}

function canContain(parentType: string | "body" | "header" | "footer", childType: string): boolean {
  const spec = componentSpec(childType);
  if (!spec) return false;
  if (!(spec.allowedParents as readonly string[]).includes(parentType)) return false;
  if (parentType !== "body" && parentType !== "header" && parentType !== "footer") {
    return componentSpec(parentType)?.allowsChildren === true;
  }
  return true;
}

export type TreeOpResult = { ok: true; tree: PdfComposition } | { ok: false; error: string };

export function insertNode(
  tree: PdfComposition,
  parentId: string | null,
  index: number,
  node: PdfNode,
  parentKind: "body" | "header" | "footer" = "body",
): TreeOpResult {
  const next = structuredClone(tree);
  if (!componentSpec(node.type)) return { ok: false, error: `unknown type ${node.type}` };
  let list: PdfNode[];
  let parentType = parentKind as string;
  if (parentId === null) {
    list = parentKind === "header" ? (next.header ??= []) : parentKind === "footer" ? (next.footer ??= []) : next.body;
  } else {
    const hit = locate(next, parentId);
    if (!hit) return { ok: false, error: `parent ${parentId} not found` };
    const spec = componentSpec(hit.node.type);
    if (!spec?.allowsChildren) return { ok: false, error: `${hit.node.type} cannot contain children` };
    hit.node.children ??= [];
    list = hit.node.children;
    parentType = hit.node.type;
  }
  if (!canContain(parentType, node.type)) {
    return { ok: false, error: `"${node.type}" is not allowed inside "${parentType}"` };
  }
  list.splice(Math.max(0, Math.min(index, list.length)), 0, node);
  return { ok: true, tree: next };
}

export function removeNode(tree: PdfComposition, id: string): TreeOpResult {
  const next = structuredClone(tree);
  const hit = locate(next, id);
  if (!hit) return { ok: false, error: `node ${id} not found` };
  hit.parent.splice(hit.index, 1);
  return { ok: true, tree: next };
}

export function moveNode(
  tree: PdfComposition,
  id: string,
  newParentId: string | null,
  index: number,
  parentKind: "body" | "header" | "footer" = "body",
): TreeOpResult {
  const hit = locate(tree, id);
  if (!hit) return { ok: false, error: `node ${id} not found` };
  const node = structuredClone(hit.node);
  const removed = removeNode(tree, id);
  if (!removed.ok) return removed;
  return insertNode(removed.tree, newParentId, index, node, parentKind);
}

export function duplicateNode(tree: PdfComposition, id: string): TreeOpResult {
  const hit = locate(tree, id);
  if (!hit) return { ok: false, error: `node ${id} not found` };
  const copy = structuredClone(hit.node);
  const reid = (n: PdfNode): void => {
    n.id = newNodeId(n.type);
    n.children?.forEach(reid);
  };
  reid(copy);
  const next = structuredClone(tree);
  const target = locate(next, id)!;
  target.parent.splice(target.index + 1, 0, copy);
  return { ok: true, tree: next };
}

export function updateNode(
  tree: PdfComposition,
  id: string,
  patch: { props?: Record<string, JsonValue>; data?: JsonValue; hidden?: boolean },
): TreeOpResult {
  const next = structuredClone(tree);
  const hit = locate(next, id);
  if (!hit) return { ok: false, error: `node ${id} not found` };
  if (patch.props) hit.node.props = { ...hit.node.props, ...patch.props };
  if (patch.data !== undefined) hit.node.data = patch.data;
  if (patch.hidden !== undefined) hit.node.hidden = patch.hidden;
  return { ok: true, tree: next };
}
