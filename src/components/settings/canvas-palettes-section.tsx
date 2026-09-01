"use client";

import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { DEFAULT_CANVAS_PALETTE_CONFIG, parseCanvasPaletteConfig, type CanvasPaletteConfig } from "@/lib/canvas/palettes";

export function CanvasPalettesSection() {
  const [config, setConfig] = useState<CanvasPaletteConfig>(DEFAULT_CANVAS_PALETTE_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/api/canvas/palettes", { cache: "no-store" })
      .then(async (response) => {
        const body: unknown = await response.json();
        if (!response.ok) throw new Error((body as { error?: string }).error || "Unable to load canvas palettes");
        const parsed = parseCanvasPaletteConfig(body);
        if (!parsed) throw new Error("Canvas palette configuration is invalid");
        return parsed;
      })
      .then((next) => { if (active) { setConfig(next); setError(null); } })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Unable to load canvas palettes"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const selectPalette = async (selectedPalette: string) => {
    const previous = config;
    const next = { ...config, selectedPalette };
    setConfig(next);
    setSaving(selectedPalette);
    setError(null);
    try {
      const response = await fetch("/api/canvas/palettes", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error((body as { error?: string }).error || "Unable to save canvas palette");
      const parsed = parseCanvasPaletteConfig(body);
      if (!parsed) throw new Error("Saved canvas palette configuration is invalid");
      setConfig(parsed);
    } catch (reason) {
      setConfig(previous);
      setError(reason instanceof Error ? reason.message : "Unable to save canvas palette");
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="border-t border-border pt-6">
      <h3 className="mb-1 text-[13px] font-semibold">Canvas palettes</h3>
      <p className="mb-4 text-[12px] text-muted-foreground">
        Choose the default palette for new canvas boards. Each board can override it and save a color per card.
      </p>
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading palettes…</div>
      ) : (
        <div role="radiogroup" aria-label="Default canvas palette" className="grid gap-2 sm:grid-cols-2">
          {config.palettes.map((palette) => {
            const selected = config.selectedPalette === palette.id;
            return (
              <button
                key={palette.id}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={saving !== null}
                onClick={() => void selectPalette(palette.id)}
                className={cn(
                  "rounded-lg border p-3 text-left transition-colors disabled:opacity-60",
                  selected ? "border-primary bg-primary/5 ring-1 ring-primary/20" : "border-border hover:border-primary/30",
                )}
              >
                <span className="mb-2 flex items-center justify-between text-[12px] font-medium">
                  {palette.name}
                  {saving === palette.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : selected ? <Check className="h-3.5 w-3.5 text-primary" /> : null}
                </span>
                <span className="flex gap-1.5">
                  {palette.colors.map((color, index) => <span key={`${color}-${index}`} className="h-5 flex-1 rounded-sm border border-foreground/10" style={{ backgroundColor: color }} />)}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-[11px] text-destructive">{error}</p>}
      <p className="mt-3 text-[11px] text-muted-foreground">
        Palette definitions are validated and stored in Cabinet’s <code>.agents/.config/canvas-palettes.json</code> data file.
      </p>
    </div>
  );
}
