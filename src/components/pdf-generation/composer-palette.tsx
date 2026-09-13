"use client";

/**
 * Left pane of the PDF composer: searchable component palette grouped by
 * catalog category. Items are draggable into the outline AND clickable —
 * a click inserts after the selected block (or appends to the body).
 * The Templates group inserts a template's body nodes as a re-id'd group.
 */
import { useMemo, useState } from "react";
import { useDraggable } from "@dnd-kit/core";
import { Search, type LucideIcon } from "lucide-react";

import { PDF_COMPONENTS, type PdfComponentSpec } from "@/lib/documents/pdf-component-catalog";
import type { PdfNode } from "@/lib/documents/pdf-composition";
import { usePdfComposerStore } from "@/lib/documents/pdf-composer-store";
import { Input } from "@/components/ui/input";
import { useLocale } from "@/i18n/use-locale";
import { cn } from "@/lib/utils";
import { catalogIcon } from "./icons";
import { componentLabel } from "./labels";

import blankTemplate from "@/lib/documents/pdf-templates/blank.json";
import invoiceTemplate from "@/lib/documents/pdf-templates/invoice.json";
import reportTemplate from "@/lib/documents/pdf-templates/report.json";

const CATEGORY_ORDER = ["Content", "Layout", "Data", "Media", "Status", "Document"] as const;

const TEMPLATES: { id: string; body: PdfNode[] }[] = [
  { id: "invoice", body: (invoiceTemplate as unknown as { body: PdfNode[] }).body },
  { id: "report", body: (reportTemplate as unknown as { body: PdfNode[] }).body },
];

void blankTemplate; // blank has no meaningful body group to insert.

function PaletteItem({ spec, icon: Icon }: { spec: PdfComponentSpec; icon: LucideIcon }) {
  const { t } = useLocale();
  const insertPalette = usePdfComposerStore((s) => s.insertPalette);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette-${spec.type}`,
    data: { kind: "palette", type: spec.type },
  });
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...listeners}
      {...attributes}
      onClick={() => insertPalette(spec.type)}
      className={cn(
        "flex w-full select-none items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent cursor-grab active:cursor-grabbing",
        isDragging && "opacity-40",
      )}
      data-palette-type={spec.type}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{componentLabel(t, spec.type, spec.label)}</span>
    </button>
  );
}

export function ComposerPalette() {
  const { t } = useLocale();
  const [query, setQuery] = useState("");
  const insertNodesAt = usePdfComposerStore((s) => s.insertNodesAt);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return CATEGORY_ORDER.map((cat) => ({
      cat,
      items: PDF_COMPONENTS.filter(
        (c) => c.category === cat && (!q || c.label.toLowerCase().includes(q) || c.type.includes(q)),
      ),
    })).filter((g) => g.items.length > 0);
  }, [query]);

  const templates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return TEMPLATES.filter((tpl) => !q || tpl.id.includes(q));
  }, [query]);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="pdf-palette">
      <div className="p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("pdfComposer:paletteSearch")}
            className="h-8 pl-7 text-xs"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {groups.map((g) => (
          <div key={g.cat} className="mb-3">
            <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
              {t(`pdfComposer:categories.${g.cat}`)}
            </div>
            {g.items.map((spec) => (
              <PaletteItem key={spec.type} spec={spec} icon={catalogIcon(spec.icon)} />
            ))}
          </div>
        ))}
        {templates.length > 0 && (
          <div className="mb-3">
            <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
              {t("pdfComposer:categories.Templates")}
            </div>
            {templates.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                onClick={() =>
                  insertNodesAt(
                    tpl.body,
                    { parentId: null, region: "body" },
                    usePdfComposerStore.getState().composition?.body.length ?? 0,
                  )
                }
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
              >
                {t(`pdfComposer:templates.${tpl.id}`)}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
