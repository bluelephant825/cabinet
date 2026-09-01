"use client";

import { useEffect, useRef, useState } from "react";
import { FileText, Link2, Loader2 } from "lucide-react";
import { ToolbarButton } from "@/components/layout/toolbar-button";
import { useEditorStore } from "@/stores/editor-store";
import { useTreeStore } from "@/stores/tree-store";

interface PageLink {
  path: string;
  title: string;
}

interface PageLinks {
  incoming: PageLink[];
  outgoing: PageLink[];
}

export function PageLinksButton({ path }: { path: string }) {
  const [open, setOpen] = useState(false);
  const [links, setLinks] = useState<PageLinks | null>(null);
  const [error, setError] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open || links) return;
    const controller = new AbortController();
    setError(false);
    fetch(`/api/pages/links?path=${encodeURIComponent(path)}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Link discovery failed");
        return response.json() as Promise<PageLinks>;
      })
      .then(setLinks)
      .catch((fetchError: unknown) => {
        if (!(fetchError instanceof DOMException && fetchError.name === "AbortError")) {
          setError(true);
        }
      });
    return () => controller.abort();
  }, [links, open, path]);

  const navigate = (targetPath: string) => {
    useTreeStore.getState().focusPath(targetPath);
    void useEditorStore.getState().loadPage(targetPath);
    setOpen(false);
  };

  const section = (label: string, items: PageLink[], empty: string) => (
    <section className="space-y-1.5">
      <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label} ({items.length})
      </h3>
      {items.length > 0 ? (
        <div className="space-y-0.5">
          {items.map((link) => (
            <button
              key={link.path}
              type="button"
              onClick={() => navigate(link.path)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
              title={link.path}
            >
              <FileText className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{link.title}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="px-1 text-xs text-muted-foreground/70">{empty}</p>
      )}
    </section>
  );

  return (
    <div ref={rootRef} className="relative">
      <ToolbarButton
        icon={Link2}
        label="Inspect links"
        title="Incoming and outgoing links"
        iconOnly
        active={open}
        onClick={() => setOpen((value) => !value)}
      />
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg">
          {!links && !error ? (
            <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading links...
            </div>
          ) : error ? (
            <p className="py-4 text-center text-xs text-muted-foreground">
              Links could not be loaded.
            </p>
          ) : links ? (
            <div className="max-h-80 space-y-4 overflow-y-auto">
              {section("Backlinks", links.incoming, "No pages link to this page.")}
              {section("Outgoing", links.outgoing, "This page has no links.")}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
