"use client";

import { useEffect, useRef, useState } from "react";
import { Link2, Globe, Loader2 } from "lucide-react";

interface Props {
  url: string;
  top: number;
  left: number;
  onEmbed: () => void;
  onDismiss: () => void;
}

// Inline chooser shown right after a bare URL is pasted on its own line: keep it
// as a plain link (default) or turn it into a web-page embed. Embed is gated on a
// frame-check probe so we never offer to embed a site that refuses framing (the
// "refused to connect" grey box).
export function PasteLinkMenu({ url, top, left, onEmbed, onDismiss }: Props) {
  // null = still probing, true = frameable, false = site blocks framing.
  const [canEmbed, setCanEmbed] = useState<boolean | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/browser/frame-check?url=${encodeURIComponent(url)}`, {
      signal: controller.signal,
    })
      .then((r) => r.json())
      // Unknown/unreachable -> allow; the iframe shows its own error if it fails.
      .then((d) => setCanEmbed(d?.ok ? !d.blocked : true))
      .catch(() => setCanEmbed(true));
    return () => controller.abort();
  }, [url]);

  // Dismiss (keep the link) on Escape or a click outside the menu.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onDismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onDismiss]);

  const blocked = canEmbed === false;

  return (
    <div
      ref={ref}
      className="fixed z-50 flex items-center gap-0.5 rounded-lg border border-border bg-popover p-1 text-[12px] shadow-xl"
      style={{ top, left }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={onDismiss}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-muted"
      >
        <Link2 className="h-3.5 w-3.5" /> Link
      </button>
      <button
        type="button"
        disabled={blocked || canEmbed === null}
        onClick={onEmbed}
        title={
          blocked ? "This site can't be embedded (it refuses framing)" : undefined
        }
        className="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
      >
        {canEmbed === null ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Globe className="h-3.5 w-3.5" />
        )}
        Embed
      </button>
    </div>
  );
}
