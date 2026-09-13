import { create } from "zustand";

/**
 * Tiny registry for the currently-open document editor (DOCX frame, later
 * PDF). The host registers `flush` so editor-scoped task dispatch can force a
 * save before an agent reads the file. Markdown editing is untouched.
 */
interface ActiveDocumentState {
  path: string | null;
  dirty: boolean;
  saving: boolean;
  /** Returns the new revision on success; throws on failure/conflict. */
  flush: (() => Promise<void>) | null;
  setActive: (s: { path: string | null; dirty: boolean; saving: boolean; flush: (() => Promise<void>) | null }) => void;
  patch: (s: Partial<Omit<ActiveDocumentState, "setActive" | "patch">>) => void;
}

export const useDocumentStore = create<ActiveDocumentState>((set) => ({
  path: null,
  dirty: false,
  saving: false,
  flush: null,
  setActive: (s) => set({ path: s.path, dirty: s.dirty, saving: s.saving, flush: s.flush }),
  patch: (s) => set(s),
}));

/** Flush the active document if one is dirty. No-op otherwise. */
export async function flushActiveDocument(): Promise<void> {
  const { dirty, flush } = useDocumentStore.getState();
  if (dirty && flush) await flush();
}
