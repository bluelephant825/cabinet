# PRD — Rooms (Workspaces) & the Home Switcher

**Status:** Shipped (v3 — true sibling rooms) · **Author:** hilash · **Last updated:** 2026-05-23
**Driver:** A home-button switcher next to the logo that moves you between *rooms* (office, study,
research, personal…), where each room is its own isolated workspace — and lets you open any room in
its own window.

> **Version history.**
> - **v1 (draft):** flatten into `data/<room>/` with a destructive migration and "nothing shared."
> - **v2 (draft):** *lighter* — keep `data/` as both the root cabinet *and* the parent of all rooms,
>   surface the existing per-cabinet isolation, **no migration**.
> - **v3 (shipped, this doc):** v2's "root is the default room" turned out to be the bug, not a
>   feature — the root cabinet was simultaneously a room *and* the physical parent of every other
>   room, so isolation could only be faked with a UI filter. v3 makes `data/` a neutral **home
>   container** and every room a true **sibling cabinet**, so isolation is structural. There *is* a
>   migration, but it is safe and idempotent.
>
> Implementation detail + the full gap analysis live in **`docs/ROOMS_V3_TRUE_ISOLATION_PLAN.md`**.
> The end-user guide is **`getting-started/rooms/`** (shipped in `resources/getting-started/`).

---

## 1. Summary

Cabinet's analogy is *your home*. v3 makes the file system match it literally: **`data/` is the home
container** (it holds your rooms but is not itself a working cabinet), and **each room is a
self-contained, isolated cabinet** at `data/<room>/` — its own pages, agents, tasks, jobs, chat,
skills, search index, and look. No room is the parent of another, so **Personal and Work never mix**.

You are always *inside a room*. The **home-button switcher** (the room's icon next to the `cabinet`
logo) lets you switch rooms, customize a room (name / icon / color / theme), add a room, or open a
room in its own window. Within a room, nested sub-cabinets still work exactly as before (roll-up
visibility own / +1 / +2 / all); across rooms there is zero knowledge.

## 2. Goals & non-goals

**Goals (all shipped)**
- One click on the room icon → a switcher: current room, list, switch, customize, add, open-in-window.
- Each room is a **structurally isolated** top-level cabinet (own subtree + own search DB). No room
  parents another.
- Per-room **identity**: icon + accent color + theme, stored in the room's `.cabinet` manifest.
- **Theme** and **search** follow the active room. Theme applies on switch; search is scoped to the room.
- A window's scope is a `cabinetPath`, so **open any room in its own window** works (Electron + web),
  each window keeping its own room and theme.
- A **safe, idempotent migration** for existing installs; **onboarding** creates rooms natively.

**Non-goals (this pass)**
- Cross-room search or cross-room agent roll-up. (Rooms are hard isolation boundaries.)
- A full retire of the `"."`-as-root code path everywhere (see §7 — we kept a thin empty "home"
  cabinet instead, on purpose).
- A dedicated home/launcher *screen* (you land directly in the default room; the switcher is the home UX).
- Templated room-types onboarding picker beyond what already exists.

## 3. Decisions (shipped)

| Question | Decision |
|---|---|
| What is a room? | A **top-level cabinet**: a direct child of `data/` with a `.cabinet` manifest (`kind: room`). Plain folders are **not** rooms (they are content inside a room). |
| What is `data/`? | The neutral **home container**. It carries a thin `.cabinet` (`kind: home`) marker + `data/.home/home.json`, but holds **no content/agents/tasks** of its own. |
| Isolation | **Structural.** Each room is a separate subtree with its **own `.cabinet.db`**. The tree is rooted per room; search is room-scoped; roll-up never crosses a room boundary (the home rolls up nothing). |
| Default room | `data/.home/home.json` `defaultRoom` (set at onboarding/migration). The app lands inside it. Renameable in the switcher. |
| Home button | The room's **icon + color** next to the logo; the dropdown switches / customizes / adds / opens-in-window. The room name shows in the drawer + main header. |
| Per-room identity | `icon` + `color` + `theme` under `room:` in each cabinet's `.cabinet` manifest. New rooms get a distinct icon/color automatically. |
| Theme | Per-room. Applied on switch and on load via `RoomThemeSync`; falls back to the global theme when unset. Lives only in the DOM, so each window themes independently. |
| Search | One `.cabinet.db` **per room**; queries are scoped to the active room (pages/agents/tasks filtered by room prefix). No cross-room leak. |
| Creation | **Add room** (switcher) → a new top-level isolated room (`kind: room` + auto icon/color). **New Cabinet** (sidebar) → a sub-cabinet *inside the current room* (`kind: child`). |
| `.global-agents` | Kept as the one opt-in **cross-room** agents location (default empty). |
| Multi-window | A window's scope is its URL hash (`#/cabinet/<room>`). Electron spawns a native `BrowserWindow` reusing the backend; web uses `window.open`. Each window keeps its own room + theme. |
| Migration | **Yes, but safe** — idempotent + git-checkpointed (`scripts/migrate-rooms-v3.mjs`). Onboarding creates rooms natively, so new installs need no migration. |

---

## 4. What shipped (where things live)

```
data/                         ← home container (NOT a working cabinet)
├── .cabinet                  ← thin kind:home marker (keeps "." a valid empty scope)
├── .home/home.json           ← { defaultRoom, lastActiveRoom }
├── .agents/.config/          ← GLOBAL app config: user, providers, onboarding-complete, integrations
├── .global-agents/           ← opt-in cross-room agents (default empty)
├── .cabinet-state/           ← machine/app state (ports, disclaimer-ack, file-schema)
├── .git/                     ← one repo for the whole home (history preserved across rooms)
├── work/                     ← a room: an isolated, self-contained cabinet
│   ├── .cabinet              ← kind:room + room:{icon,color,theme}
│   ├── .cabinet.db           ← this room's own search index
│   ├── .agents/  .jobs/  .chat/  .cabinet-state/
│   ├── getting-started/  index.md  …content…
│   └── …nested sub-cabinets (kind:child) roll up within the room…
├── personal/                 ← another room, fully isolated from `work`
└── …more sibling rooms…
```

| Concern | Implementation |
|---|---|
| Room list | `listRooms()` (`src/lib/cabinets/rooms.ts`) — top-level dirs with a `.cabinet`, excluding `kind:home`. |
| Default room | `resolveDefaultRoom()` + `data/.home/home.json`; returned by `/api/rooms`. |
| Switcher UI | `src/components/sidebar/room-switcher.tsx` (+ `room-icons.tsx`, `room-edit-dialog.tsx`). |
| Landing | `app-shell.tsx` redirects the bare home section into the default room; `handleWizardComplete` refreshes the rooms store post-onboarding. |
| Tree scope | Rooted per active room (`tree-view.tsx` uses the room's subtree). |
| Search scope | `server/search/*` filters pages/agents/tasks by the active room prefix; `cabinet` param threaded `palette → /api/search → daemon`. |
| Roll-up cap | `overview.ts` returns no descendants for the home (`DATA_DIR`), so no parent can see another room. |
| Per-room theme | `src/components/layout/room-theme-sync.tsx` (mounted in `layout.tsx`). |
| Creation | `/api/cabinets/create` (room vs child by `parentPath`); `cabinet-scaffold.ts` (`kind` union incl. `room`/`home`). |
| Onboarding | `/api/onboarding/setup` scaffolds the first room at `data/<slug>/`, writes the home marker, keeps global config at the container. |
| Multi-window | `src/lib/cabinets/room-window.ts`; Electron `cabinet:open-window` IPC (`electron/main.cjs`) + `preload.cjs` `CabinetDesktop.openWindow`. |
| Migration | `scripts/migrate-rooms-v3.mjs` (idempotent, guarded by `data/.home/home.json`). |

## 5. Migration (existing installs)

Pre-v3 installs have a root cabinet at `data/` that parents the other rooms. `migrate-rooms-v3.mjs`:
1. No-ops if `data/.home/home.json` already exists (idempotent).
2. Git-checkpoints `data/` ("pre rooms-v3 migration").
3. Moves the root cabinet's content/agents/chat/db/index + plain content folders into `data/<rootSlug>/`.
4. Leaves existing top-level cabinets in place as sibling rooms; backfills distinct icons/colors.
5. Keeps global config at `data/.agents/.config`; writes the home marker + `data/.home/home.json`.

New installs skip all of this — onboarding creates the first room directly.

## 6. Phased plan — status

- **Phase 1 — Switcher + room identity.** ✅ Shipped.
- **Phase 2 — Per-room theme.** ✅ Shipped (apply on switch + load, global fallback).
- **Phase 3 — Scoped search.** ✅ Shipped (per-room DB scope by prefix).
- **Phase 4 — Add / Edit / Create (room vs sub-cabinet).** ✅ Shipped.
- **Phase 5 — Multi-window.** ✅ Shipped (Electron native window + web `window.open`).
- **Phase 6 — Onboarding.** ✅ Shipped (creates `data/<slug>/` rooms + home marker).
- **Migration + structural isolation (the v3 core).** ✅ Shipped (`migrate-rooms-v3.mjs`).

## 7. Notes, risks & remaining

- **Why a thin `kind:home` cabinet instead of deleting `data/.cabinet`.** ~114 call sites default an
  absent `cabinetPath` to the root (`"."`). Rather than a risky full retire-`.` refactor, `data/`
  keeps a thin, **content-less** `kind:home` cabinet so those sites resolve to a valid but empty
  (leak-free) scope. Isolation still holds: the home has no content/agents and rolls up nothing.
- **Cold-load theme flash (minor).** On a fresh load the global theme paints before the room theme,
  which resolves after the async rooms fetch. Acceptable; not blocking.
- **Verification.** The model, isolation, theme-on-switch, multi-window, and from-scratch onboarding
  were all verified via Chrome DevTools + filesystem inspection (see `PROGRESS.md`, 2026-05-23).
- **Truly remaining:** nothing blocking.

---

*Superseded directions (v1 flatten, v2 lighter) are retained in §version-history for context. The
shipped contract is this document + `docs/ROOMS_V3_TRUE_ISOLATION_PLAN.md`.*
