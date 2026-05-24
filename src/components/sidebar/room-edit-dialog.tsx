"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ROOM_ICON_KEYS, getRoomIcon, ROOM_COLORS } from "@/lib/cabinets/room-icons";
import { THEMES } from "@/lib/themes";
import { useRoomsStore, type RoomMetaClient } from "@/stores/rooms-store";
import { useLocale } from "@/i18n/use-locale";

interface RoomEditDialogProps {
  room: RoomMetaClient;
  onClose: () => void;
  /** Called after a successful save with the updated room. */
  onSaved?: (room: RoomMetaClient) => void;
}

export function RoomEditDialog({ room, onClose, onSaved }: RoomEditDialogProps) {
  const { t } = useLocale();
  const reloadRooms = useRoomsStore((s) => s.load);
  const [name, setName] = useState(room.name);
  const [icon, setIcon] = useState<string | null>(room.icon);
  const [color, setColor] = useState<string | null>(room.color);
  const [theme, setTheme] = useState<string | null>(room.theme);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose, saving]);

  async function handleSave(e?: React.FormEvent) {
    e?.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/rooms", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: room.path,
          name: name.trim() || room.name,
          icon,
          color,
          theme,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || t("rooms:editFailed"));
        setSaving(false);
        return;
      }
      const data = (await res.json()) as { room: RoomMetaClient };
      await reloadRooms(true);
      onSaved?.(data.room);
      onClose();
    } catch {
      setError(t("rooms:editFailed"));
      setSaving(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-background/80 backdrop-blur-md"
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div className="relative w-full max-w-md mx-4 my-16 bg-card rounded-2xl border border-border shadow-2xl">
        <div className="flex items-start justify-between px-6 pt-6 pb-3">
          <div>
            <h2 className="text-lg font-semibold text-foreground">
              {t("rooms:editTitle")}
            </h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              {t("rooms:editSubtitle")}
            </p>
          </div>
          <button
            onClick={() => !saving && onClose()}
            disabled={saving}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            aria-label={t("common:actions.close")}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSave} className="px-6 pb-6 space-y-5">
          {/* Name */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">
              {t("rooms:nameLabel")}
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              className="h-10"
              disabled={saving}
            />
          </div>

          {/* Icon */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">
              {t("rooms:iconLabel")}
            </label>
            <div className="grid grid-cols-7 gap-1.5">
              {ROOM_ICON_KEYS.map((key) => {
                const Icon = getRoomIcon(key);
                const selected = icon === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setIcon(key)}
                    aria-label={key}
                    aria-pressed={selected}
                    className={cn(
                      "flex h-9 w-9 items-center justify-center rounded-lg border transition-colors",
                      selected
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border/60 text-muted-foreground hover:bg-accent hover:text-foreground"
                    )}
                  >
                    <Icon className="h-4 w-4" />
                  </button>
                );
              })}
            </div>
          </div>

          {/* Color */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">
              {t("rooms:colorLabel")}
            </label>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setColor(null)}
                aria-pressed={color === null}
                className={cn(
                  "flex h-7 items-center rounded-lg border px-2.5 text-xs transition-colors",
                  color === null
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border/60 text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                {t("rooms:colorAuto")}
              </button>
              {ROOM_COLORS.map((swatch) => {
                const selected = color === swatch;
                return (
                  <button
                    key={swatch}
                    type="button"
                    onClick={() => setColor(swatch)}
                    aria-label={swatch}
                    aria-pressed={selected}
                    className={cn(
                      "flex h-7 w-7 items-center justify-center rounded-lg border transition-colors",
                      selected ? "border-foreground/40" : "border-transparent hover:border-border"
                    )}
                  >
                    <span
                      className="h-4 w-4 rounded-full"
                      style={{ backgroundColor: swatch }}
                    />
                  </button>
                );
              })}
            </div>
          </div>

          {/* Theme */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">
              {t("rooms:themeLabel")}
            </label>
            <div className="grid grid-cols-2 gap-1.5 max-h-40 overflow-y-auto pe-1">
              <button
                type="button"
                onClick={() => setTheme(null)}
                className={cn(
                  "flex items-center justify-between rounded-lg border px-3 py-2 text-sm transition-colors",
                  theme === null
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border/60 text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                {t("rooms:themeGlobal")}
                {theme === null && <Check className="h-3.5 w-3.5" />}
              </button>
              {THEMES.map((th) => {
                const selected = theme === th.name;
                return (
                  <button
                    key={th.name}
                    type="button"
                    onClick={() => setTheme(th.name)}
                    className={cn(
                      "flex items-center justify-between rounded-lg border px-3 py-2 text-sm transition-colors",
                      selected
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border/60 text-muted-foreground hover:bg-accent hover:text-foreground"
                    )}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <span
                        className="h-3 w-3 shrink-0 rounded-full border border-black/10"
                        style={{ backgroundColor: th.accent }}
                      />
                      <span className="truncate">{th.label}</span>
                    </span>
                    {selected && <Check className="h-3.5 w-3.5 shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex items-center justify-end gap-3 pt-1 border-t border-border">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={saving}
            >
              {t("common:actions.cancel")}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? t("common:states.saving") : t("common:actions.save")}
            </Button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
