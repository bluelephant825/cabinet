"use client";

/**
 * Right pane of the PDF composer: the inspector. With a node selected it
 * renders a form generated from the catalog's propSchema (plus the data
 * editors for table/kv/chart payloads and the asset picker); with nothing
 * selected it edits document-level fields (title, page, margins, theme,
 * declared assets). The "Edit JSON" toggle exposes the raw node/document
 * with validate-on-blur — invalid JSON never replaces the tree.
 */
import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import type { JsonValue, PdfComposition, PdfNode } from "@/lib/documents/pdf-composition";
import { validateComposition } from "@/lib/documents/pdf-composition";
import {
  PDF_THEMES,
  componentSpec,
  type PdfPropSpec,
} from "@/lib/documents/pdf-component-catalog";
import { locateIn, usePdfComposerStore } from "@/lib/documents/pdf-composer-store";
import { useTreeStore } from "@/stores/tree-store";
import type { TreeNode } from "@/types";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useLocale } from "@/i18n/use-locale";
import { cn } from "@/lib/utils";
import { componentLabel, propLabel } from "./labels";

const inputCls = "h-8 text-xs";
const selectCls =
  "h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mb-2 block">
      <span className="mb-0.5 block select-none text-[11px] font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

// ── data editors ─────────────────────────────────────────────────────────────

function RowsEditor({
  data,
  onChange,
}: {
  data: { columns: string[]; rows: string[][] };
  onChange: (d: JsonValue) => void;
}) {
  const { t } = useLocale();
  const setCell = (r: number, c: number, v: string) => {
    const rows = data.rows.map((row, i) => (i === r ? row.map((cell, j) => (j === c ? v : cell)) : row));
    onChange({ ...data, rows } as unknown as JsonValue);
  };
  const setCol = (c: number, v: string) =>
    onChange({ ...data, columns: data.columns.map((x, i) => (i === c ? v : x)) } as unknown as JsonValue);
  return (
    <div className="mb-3">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead className="select-none">
            <tr>
              {data.columns.map((col, ci) => (
                <th key={ci} className="border border-border p-0">
                  <input
                    className="w-full select-text bg-muted/40 px-1 py-0.5 text-[11px] font-medium outline-none"
                    value={col}
                    onChange={(e) => setCol(ci, e.target.value)}
                  />
                </th>
              ))}
              <th className="border border-border p-0">
                <button
                  type="button"
                  className="w-full px-1 py-0.5 text-muted-foreground hover:bg-accent"
                  aria-label={t("pdfComposer:addColumn")}
                  onClick={() =>
                    onChange({
                      ...data,
                      columns: [...data.columns, `Col ${data.columns.length + 1}`],
                      rows: data.rows.map((r) => [...r, ""]),
                    } as unknown as JsonValue)
                  }
                >
                  <Plus className="mx-auto h-3 w-3" />
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, ri) => (
              <tr key={ri}>
                {data.columns.map((_, ci) => (
                  <td key={ci} className="border border-border p-0">
                    <input
                      className="w-full px-1 py-0.5 text-[11px] outline-none"
                      value={row[ci] ?? ""}
                      onChange={(e) => setCell(ri, ci, e.target.value)}
                    />
                  </td>
                ))}
                <td className="border border-border p-0">
                  <button
                    type="button"
                    className="w-full px-1 py-0.5 text-muted-foreground hover:bg-accent"
                    aria-label={t("pdfComposer:removeRow")}
                    onClick={() =>
                      onChange({ ...data, rows: data.rows.filter((_, i) => i !== ri) } as unknown as JsonValue)
                    }
                  >
                    <Trash2 className="mx-auto h-3 w-3" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="mt-1 h-7 text-xs"
        onClick={() =>
          onChange({ ...data, rows: [...data.rows, data.columns.map(() => "")] } as unknown as JsonValue)
        }
      >
        <Plus className="mr-1 h-3 w-3" /> {t("pdfComposer:addRow")}
      </Button>
    </div>
  );
}

function KvEditor({
  data,
  onChange,
}: {
  data: { entries: { key: string; value: string }[] };
  onChange: (d: JsonValue) => void;
}) {
  const { t } = useLocale();
  return (
    <div className="mb-3">
      {data.entries.map((e, i) => (
        <div key={i} className="mb-1 flex gap-1">
          <input
            className="h-7 w-2/5 rounded-md border border-input bg-background px-1.5 text-[11px]"
            value={e.key}
            placeholder="Key"
            onChange={(ev) =>
              onChange({
                entries: data.entries.map((x, j) => (j === i ? { ...x, key: ev.target.value } : x)),
              } as unknown as JsonValue)
            }
          />
          <input
            className="h-7 flex-1 rounded-md border border-input bg-background px-1.5 text-[11px]"
            value={e.value}
            placeholder="Value"
            onChange={(ev) =>
              onChange({
                entries: data.entries.map((x, j) => (j === i ? { ...x, value: ev.target.value } : x)),
              } as unknown as JsonValue)
            }
          />
          <button
            type="button"
            className="text-muted-foreground hover:text-destructive"
            aria-label={t("pdfComposer:removeRow")}
            onClick={() =>
              onChange({ entries: data.entries.filter((_, j) => j !== i) } as unknown as JsonValue)
            }
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        className="mt-1 h-7 text-xs"
        onClick={() =>
          onChange({ entries: [...data.entries, { key: "", value: "" }] } as unknown as JsonValue)
        }
      >
        <Plus className="mr-1 h-3 w-3" /> {t("pdfComposer:addEntry")}
      </Button>
    </div>
  );
}

function ChartEditor({
  data,
  onChange,
}: {
  data: JsonValue | undefined;
  onChange: (d: JsonValue) => void;
}) {
  const { t } = useLocale();
  const points = (data as { data?: unknown })?.data ?? data;
  const simple =
    Array.isArray(points) &&
    points.every((p) => p && typeof p === "object" && !Array.isArray(p) && "label" in p);
  const [raw, setRaw] = useState(() => JSON.stringify(points ?? [], null, 2));
  const [err, setErr] = useState<string | null>(null);

  if (simple) {
    const rows = points as { label: string; value: number }[];
    return (
      <div className="mb-3">
        {rows.map((p, i) => (
          <div key={i} className="mb-1 flex gap-1">
            <input
              className="h-7 flex-1 rounded-md border border-input bg-background px-1.5 text-[11px]"
              value={p.label}
              onChange={(ev) =>
                onChange({
                  data: rows.map((x, j) => (j === i ? { ...x, label: ev.target.value } : x)),
                } as unknown as JsonValue)
              }
            />
            <input
              className="h-7 w-20 rounded-md border border-input bg-background px-1.5 text-[11px]"
              type="number"
              value={p.value}
              onChange={(ev) =>
                onChange({
                  data: rows.map((x, j) => (j === i ? { ...x, value: Number(ev.target.value) } : x)),
                } as unknown as JsonValue)
              }
            />
            <button
              type="button"
              className="text-muted-foreground hover:text-destructive"
              aria-label={t("pdfComposer:removeRow")}
              onClick={() =>
                onChange({ data: rows.filter((_, j) => j !== i) } as unknown as JsonValue)
              }
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          className="mt-1 h-7 text-xs"
          onClick={() =>
            onChange({ data: [...rows, { label: "", value: 0 }] } as unknown as JsonValue)
          }
        >
          <Plus className="mr-1 h-3 w-3" /> {t("pdfComposer:addPoint")}
        </Button>
      </div>
    );
  }

  return (
    <div className="mb-3">
      <textarea
        className="min-h-24 w-full rounded-md border border-input bg-background p-1.5 font-mono text-[11px]"
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={() => {
          try {
            const parsed = JSON.parse(raw);
            setErr(null);
            onChange(parsed as JsonValue);
          } catch {
            setErr(t("pdfComposer:invalidJson"));
          }
        }}
      />
      {err && <p className="text-[11px] text-destructive">{err}</p>}
    </div>
  );
}

// ── asset picker ─────────────────────────────────────────────────────────────

function findFolder(nodes: TreeNode[], path: string): TreeNode | null {
  for (const n of nodes) {
    if (n.path === path && n.type === "directory") return n;
    const hit = n.children ? findFolder(n.children, path) : null;
    if (hit) return hit;
  }
  return null;
}

function collectFiles(node: TreeNode, base: string, out: string[] = []): string[] {
  for (const c of node.children ?? []) {
    if (c.type === "directory") collectFiles(c, `${base}${c.name}/`, out);
    else out.push(`${base}${c.name}`);
  }
  return out;
}

function AssetPicker({
  composition,
  value,
  sourcePath,
  onPick,
}: {
  composition: PdfComposition;
  value: string;
  sourcePath: string;
  onPick: (assetKey: string) => void;
}) {
  const { t } = useLocale();
  const nodes = useTreeStore((s) => s.nodes);
  const folder = sourcePath.split("/").slice(0, -1).join("/");
  const files = useMemo(() => {
    const dir = findFolder(nodes, folder || ".");
    return dir ? collectFiles(dir, "") : [];
  }, [nodes, folder]);
  const assets = composition.assets ?? {};

  return (
    <div className="flex gap-1">
      <select
        className={selectCls}
        value={value}
        onChange={(e) => onPick(e.target.value)}
        aria-label={t("pdfComposer:assetRef")}
      >
        <option value="">{t("pdfComposer:pickAsset")}</option>
        {Object.keys(assets).map((k) => (
          <option key={k} value={k}>
            {k} → {assets[k].path}
          </option>
        ))}
      </select>
      <select
        className={selectCls}
        value=""
        aria-label={t("pdfComposer:pickFile")}
        onChange={(e) => {
          const p = e.target.value;
          if (!p) return;
          // Reuse an existing declaration for the same path, else declare.
          const existing = Object.entries(assets).find(([, a]) => a.path === p);
          if (existing) {
            onPick(existing[0]);
            return;
          }
          const stem = p.split("/").pop()!.split(".")[0].toLowerCase().replace(/[^a-z0-9-]/g, "-");
          let key = stem || "asset";
          let i = 2;
          while (assets[key]) key = `${stem}-${i++}`;
          onPick(`new:${key}:${p}`);
        }}
      >
        <option value="">{t("pdfComposer:declareFile")}</option>
        {files.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
    </div>
  );
}

// ── prop field ───────────────────────────────────────────────────────────────

function PropField({
  name,
  label,
  spec,
  value,
  composition,
  sourcePath,
  onChange,
  onAsset,
}: {
  name: string;
  label: string;
  spec: PdfPropSpec;
  value: JsonValue | undefined;
  composition: PdfComposition;
  sourcePath: string;
  onChange: (v: JsonValue) => void;
  onAsset: (decl: { key: string; path: string } | { key: string }) => void;
}) {
  const { t } = useLocale();

  if (spec.type === "boolean") {
    return (
      <Field label={label}>
        <Switch checked={value === true} onCheckedChange={(v) => onChange(v === true)} />
      </Field>
    );
  }
  if (spec.enum) {
    return (
      <Field label={label}>
        <select
          className={selectCls}
          value={String(value ?? "")}
          onChange={(e) =>
            onChange(spec.type === "number" ? Number(e.target.value) : e.target.value)
          }
        >
          <option value="">—</option>
          {spec.enum.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </Field>
    );
  }
  if (spec.type === "number" || spec.type === "length-pt") {
    return (
      <Field label={spec.type === "length-pt" ? `${label} (pt)` : label}>
        <Input
          type="number"
          className={inputCls}
          min={spec.min}
          max={spec.max}
          value={typeof value === "number" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
        />
      </Field>
    );
  }
  if (spec.type === "color") {
    const str = typeof value === "string" ? value : "";
    return (
      <Field label={label}>
        <div className="flex items-center gap-1.5">
          <span
            className="h-6 w-6 shrink-0 rounded border border-border"
            style={{ background: str || "transparent" }}
          />
          <Input className={inputCls} value={str} onChange={(e) => onChange(e.target.value)} />
        </div>
      </Field>
    );
  }
  if (spec.type === "asset-ref") {
    return (
      <Field label={label}>
        <AssetPicker
          composition={composition}
          value={typeof value === "string" ? value : ""}
          sourcePath={sourcePath}
          onPick={(key) => {
            if (key.startsWith("new:")) {
              const [, k, p] = key.split(":");
              onAsset({ key: k, path: p });
            } else {
              onAsset({ key });
            }
          }}
        />
      </Field>
    );
  }
  if (spec.type === "json") {
    return (
      <Field label={label}>
        <JsonPropEditor value={value} onChange={onChange} />
      </Field>
    );
  }
  // string / url
  const str = typeof value === "string" ? value : "";
  const urlBad =
    spec.type === "url" &&
    str !== "" &&
    !(/^(https|mailto):/i.test(str) || (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(str) && !str.split("/").includes("..")));
  return (
    <Field label={label}>
      {name === "text" && spec.type === "string" ? (
        <textarea
          className="min-h-16 w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs"
          value={str}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <Input className={inputCls} value={str} onChange={(e) => onChange(e.target.value)} />
      )}
      {spec.hint && <p className="mt-0.5 text-[10px] text-muted-foreground/60">{spec.hint}</p>}
      {urlBad && <p className="mt-0.5 text-[10px] text-destructive">{t("pdfComposer:badUrl")}</p>}
    </Field>
  );
}

function JsonPropEditor({
  value,
  onChange,
}: {
  value: JsonValue | undefined;
  onChange: (v: JsonValue) => void;
}) {
  const { t } = useLocale();
  const [raw, setRaw] = useState(() => JSON.stringify(value ?? null, null, 2));
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <textarea
        className={cn(
          "min-h-16 w-full rounded-md border bg-background p-1.5 font-mono text-[11px]",
          err ? "border-destructive" : "border-input",
        )}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={() => {
          try {
            onChange(JSON.parse(raw) as JsonValue);
            setErr(null);
          } catch {
            setErr(t("pdfComposer:invalidJson"));
          }
        }}
      />
      {err && <p className="mt-0.5 text-[10px] text-destructive">{err}</p>}
    </>
  );
}

// ── document section ─────────────────────────────────────────────────────────

function DocumentForm() {
  const { t } = useLocale();
  const composition = usePdfComposerStore((s) => s.composition)!;
  const setDoc = usePdfComposerStore((s) => s.setDoc);
  const path = usePdfComposerStore((s) => s.path)!;
  const nodes = useTreeStore((s) => s.nodes);
  const folder = path.split("/").slice(0, -1).join("/");
  const files = useMemo(() => {
    const dir = findFolder(nodes, folder || ".");
    return dir ? collectFiles(dir, "") : [];
  }, [nodes, folder]);

  const page = composition.page;
  const sizeStr = typeof page.size === "string" ? page.size : "custom";
  const assets = composition.assets ?? {};

  return (
    <div>
      <Field label={t("pdfComposer:docTitle")}>
        <Input
          className={inputCls}
          value={composition.title ?? ""}
          onChange={(e) => setDoc({ title: e.target.value })}
        />
      </Field>
      <Field label={t("pdfComposer:pageSize")}>
        <select
          className={selectCls}
          value={sizeStr}
          onChange={(e) => {
            if (e.target.value === "custom") return;
            setDoc({ page: { ...page, size: e.target.value as "A4" | "Letter" | "Legal" } });
          }}
        >
          {["A4", "Letter", "Legal", "custom"].map((s) => (
            <option key={s} value={s} disabled={s === "custom"}>
              {s}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t("pdfComposer:orientation")}>
        <select
          className={selectCls}
          value={page.orientation}
          onChange={(e) =>
            setDoc({ page: { ...page, orientation: e.target.value as "portrait" | "landscape" } })
          }
        >
          <option value="portrait">{t("pdfComposer:portrait")}</option>
          <option value="landscape">{t("pdfComposer:landscape")}</option>
        </select>
      </Field>
      <div className="mb-2 grid grid-cols-4 gap-1">
        {(
          [
            ["top", t("pdfComposer:margins.top")],
            ["right", t("pdfComposer:margins.right")],
            ["bottom", t("pdfComposer:margins.bottom")],
            ["left", t("pdfComposer:margins.left")],
          ] as const
        ).map(([side, sideLabel]) => (
          <label key={side} className="block">
            <span className="mb-0.5 block text-[10px] text-muted-foreground">{sideLabel}</span>
            <Input
              type="number"
              className="h-7 px-1 text-xs"
              min={0}
              max={400}
              value={page.margins[side]}
              onChange={(e) =>
                setDoc({
                  page: {
                    ...page,
                    margins: { ...page.margins, [side]: Number(e.target.value) || 0 },
                  },
                })
              }
            />
          </label>
        ))}
      </div>
      <Field label={t("pdfComposer:theme")}>
        <div className="flex gap-1.5">
          {PDF_THEMES.map((theme) => (
            <button
              key={theme}
              type="button"
              onClick={() => setDoc({ theme })}
              className={cn(
                "flex-1 rounded-md border px-2 py-1.5 text-[11px] capitalize transition-colors",
                composition.theme === theme
                  ? "border-primary/50 bg-primary/5 ring-1 ring-primary/30"
                  : "border-border text-muted-foreground hover:bg-foreground/3",
              )}
            >
              {t(`pdfComposer:themes.${theme}`)}
            </button>
          ))}
        </div>
      </Field>
      <div className="mb-2">
        <div className="mb-0.5 text-[11px] font-medium text-muted-foreground">
          {t("pdfComposer:assets")}
        </div>
        {Object.entries(assets).map(([key, a]) => (
          <div key={key} className="mb-1 flex items-center gap-1 text-[11px]">
            <span className="w-20 truncate font-mono">{key}</span>
            <span className="flex-1 truncate text-muted-foreground">{a.path}</span>
            <button
              type="button"
              className="text-muted-foreground hover:text-destructive"
              aria-label={t("pdfComposer:removeAsset")}
              onClick={() => {
                const next = { ...assets };
                delete next[key];
                setDoc({ assets: next });
              }}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ))}
        <select
          className={selectCls}
          value=""
          aria-label={t("pdfComposer:addAsset")}
          onChange={(e) => {
            const p = e.target.value;
            if (!p) return;
            const stem = p.split("/").pop()!.split(".")[0].toLowerCase().replace(/[^a-z0-9-]/g, "-");
            let key = stem || "asset";
            let i = 2;
            while (assets[key]) key = `${stem}-${i++}`;
            setDoc({ assets: { ...assets, [key]: { path: p } } });
          }}
        >
          <option value="">{t("pdfComposer:addAsset")}</option>
          {files.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

// ── JSON view ────────────────────────────────────────────────────────────────

function JsonEditor() {
  const { t } = useLocale();
  const composition = usePdfComposerStore((s) => s.composition)!;
  const selectedId = usePdfComposerStore((s) => s.selectedId);
  const commit = usePdfComposerStore((s) => s.commit);
  const target: unknown = selectedId
    ? locateIn(composition, selectedId)?.node ?? composition
    : composition;
  const [raw, setRaw] = useState(() => JSON.stringify(target, null, 2));
  const [errors, setErrors] = useState<string[]>([]);
  useEffect(() => {
    setRaw(JSON.stringify(target, null, 2));
    setErrors([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-seed on selection change
  }, [selectedId]);

  return (
    <div>
      <textarea
        className={cn(
          "min-h-[40vh] w-full rounded-md border bg-background p-2 font-mono text-[11px] leading-relaxed",
          errors.length ? "border-destructive" : "border-input",
        )}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={() => {
          try {
            const parsed: unknown = JSON.parse(raw);
            if (selectedId) {
              // Node-level edits go through a whole-composition replace so the
              // catalog validation still applies.
              const c = structuredClone(composition);
              const loc = locateIn(c, selectedId);
              if (!loc) return;
              const list = loc.parentId
                ? (locateIn(c, loc.parentId)?.node.children ?? [])
                : (c[loc.region === "body" ? "body" : loc.region] as PdfNode[]);
              list[loc.index] = parsed as PdfNode;
              const res = validateComposition(c);
              if (!res.ok) {
                setErrors(res.errors.map((e) => `${e.path}: ${e.message}`));
                return;
              }
              setErrors([]);
              commit(c);
            } else {
              const res = validateComposition(parsed);
              if (!res.ok) {
                setErrors(res.errors.map((e) => `${e.path}: ${e.message}`));
                return;
              }
              setErrors([]);
              commit(res.value);
            }
          } catch {
            setErrors([t("pdfComposer:invalidJson")]);
          }
        }}
      />
      {errors.length > 0 && (
        <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto text-[10px] text-destructive">
          {errors.slice(0, 20).map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── inspector root ───────────────────────────────────────────────────────────

export function ComposerInspector() {
  const { t } = useLocale();
  const composition = usePdfComposerStore((s) => s.composition);
  const selectedId = usePdfComposerStore((s) => s.selectedId);
  const path = usePdfComposerStore((s) => s.path);
  const updateProps = usePdfComposerStore((s) => s.updateProps);
  const updateData = usePdfComposerStore((s) => s.updateData);
  const setDoc = usePdfComposerStore((s) => s.setDoc);
  const [jsonMode, setJsonMode] = useState(false);
  const firstFieldRef = useMemo(() => ({ current: 0 }), []);

  useEffect(() => {
    const handler = () => {
      const el = document.querySelector<HTMLElement>("[data-testid='pdf-inspector'] input, [data-testid='pdf-inspector'] textarea, [data-testid='pdf-inspector'] select");
      el?.focus();
    };
    window.addEventListener("pdfcomposer:focus-inspector", handler);
    return () => window.removeEventListener("pdfcomposer:focus-inspector", handler);
  }, []);
  void firstFieldRef;

  if (!composition || !path) return null;
  const loc = selectedId ? locateIn(composition, selectedId) : null;
  const node = loc?.node ?? null;
  const spec = node ? componentSpec(node.type) : null;

  const onAsset = (decl: { key: string; path?: string } | { key: string }) => {
    if (!node) return;
    if ("path" in decl && decl.path) {
      setDoc({ assets: { ...(composition.assets ?? {}), [decl.key]: { path: decl.path } } });
    }
    updateProps(node.id, { asset: decl.key });
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="pdf-inspector">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="select-none text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">
          {node ? (spec ? componentLabel(t, spec.type, spec.label) : node.type) : t("pdfComposer:document")}
        </span>
        <button
          type="button"
          onClick={() => setJsonMode(!jsonMode)}
          className="select-none text-[10px] text-muted-foreground hover:text-foreground"
        >
          {jsonMode ? t("pdfComposer:formView") : t("pdfComposer:jsonView")}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {jsonMode ? (
          <JsonEditor />
        ) : node && spec ? (
          <>
            {Object.entries(spec.props).map(([name, ps]) => (
              <PropField
                key={name}
                name={name}
                label={propLabel(t, node.type, name)}
                spec={ps}
                value={node.props?.[name]}
                composition={composition}
                sourcePath={path}
                onChange={(v) => updateProps(node.id, { [name]: v })}
                onAsset={onAsset}
              />
            ))}
            {spec.data?.kind === "rows" && (
              <>
                <div className="mb-1 select-none text-[11px] font-medium text-muted-foreground">
                  {t("pdfComposer:tableData")}
                </div>
                <RowsEditor
                  data={(node.data as { columns: string[]; rows: string[][] }) ?? { columns: [], rows: [] }}
                  onChange={(d) => updateData(node.id, d)}
                />
              </>
            )}
            {spec.data?.kind === "kv" && (
              <>
                <div className="mb-1 select-none text-[11px] font-medium text-muted-foreground">
                  {t("pdfComposer:kvData")}
                </div>
                <KvEditor
                  data={(node.data as { entries: { key: string; value: string }[] }) ?? { entries: [] }}
                  onChange={(d) => updateData(node.id, d)}
                />
              </>
            )}
            {spec.data?.kind === "chart" && (
              <>
                <div className="mb-1 select-none text-[11px] font-medium text-muted-foreground">
                  {t("pdfComposer:chartData")}
                </div>
                <ChartEditor data={node.data} onChange={(d) => updateData(node.id, d)} />
              </>
            )}
          </>
        ) : (
          <DocumentForm />
        )}
      </div>
    </div>
  );
}
