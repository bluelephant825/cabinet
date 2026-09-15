"use client";

/**
 * Local Font Access fallback for the document editors' font pickers — used
 * only when the daemon's fonts/list inventory is empty. queryLocalFonts
 * needs user activation, so callers invoke `load` from a select's first
 * focus/mousedown; permission errors are swallowed (empty list).
 */
import { useCallback, useRef, useState } from "react";

export function useLocalFonts(): { families: string[]; load: () => void } {
  const [families, setFamilies] = useState<string[]>([]);
  const tried = useRef(false);
  const load = useCallback(() => {
    if (tried.current) return;
    tried.current = true;
    const query = (
      window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }
    ).queryLocalFonts;
    if (!query) return;
    void query
      .call(window)
      .then((fonts) => {
        const set = new Set<string>();
        for (const f of fonts) if (f.family) set.add(f.family);
        setFamilies([...set].sort((a, b) => a.localeCompare(b)));
      })
      .catch(() => {});
  }, []);
  return { families, load };
}
