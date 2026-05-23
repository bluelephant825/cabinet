import { create } from "zustand";

export interface RoomMetaClient {
  path: string;
  name: string;
  icon: string | null;
  theme: string | null;
  color: string | null;
  isRoot: boolean;
}

interface RoomsState {
  rooms: RoomMetaClient[];
  loaded: boolean;
  loading: boolean;
  /** Fetch the room list. No-op if already loaded unless `force`. */
  load: (force?: boolean) => Promise<void>;
}

/**
 * Shared client cache of the room list, used by both the home-button switcher
 * and the per-room theme sync so they don't each fetch independently.
 */
export const useRoomsStore = create<RoomsState>((set, get) => ({
  rooms: [],
  loaded: false,
  loading: false,
  load: async (force = false) => {
    const { loaded, loading } = get();
    if (loading) return;
    if (loaded && !force) return;
    set({ loading: true });
    try {
      const res = await fetch("/api/rooms");
      if (!res.ok) return;
      const data = (await res.json()) as { rooms?: RoomMetaClient[] };
      set({ rooms: data.rooms ?? [], loaded: true });
    } catch {
      // ignore — a later interaction retries
    } finally {
      set({ loading: false });
    }
  },
}));
