# Design — Rooms v3: True Sibling Rooms + Migration

**Status:** Shipped + verified 2026-05-23 · **Author:** hilash
**Relationship:** the implementation companion to `ROOMS_WORKSPACES_PRD.md` (v3). This doc holds the
gap analysis, migration spec, and code-level detail; the PRD holds the product contract.

> **Implementation note (2026-05-23).** Shipped with one pragmatic deviation from §1.1: rather than
> deleting `data/.cabinet`, the data root keeps a thin `kind: home` manifest so the ~114 existing
> `"."`-as-root call sites resolve to a valid but **empty** scope (nothing to leak) instead of needing
> a full retire-`.` refactor. Isolation is still structural: every room is a separate subtree with its
> own `.cabinet.db`, the home is content-less, `listRooms()` excludes it, the app always lands in a
> room, and roll-up never crosses a room boundary. Migration: `scripts/migrate-rooms-v3.mjs`
> (idempotent, git-checkpointed). Verified via Chrome DevTools + filesystem: switcher lists only real
> rooms with distinct avatars; switching shows fully different agents/activity/tree; a new "personal"
> room is an isolated top-level sibling; `search?cabinet=salesons` does not return sales pages.
>
> **Onboarding (DONE 2026-05-23):** `api/onboarding/setup` now scaffolds the first cabinet as an
> isolated room at `data/<slug>/` (kind:room + icon/color), keeps global app config at the container
> (`data/.agents/.config`), writes the home marker (`data/.cabinet` kind:home + `data/.home/home.json`),
> and puts the first agent + chat inside the room. `handleWizardComplete` force-reloads the rooms store
> so the post-onboarding landing drops you inside the new room. Verified from scratch (wipe data →
> wizard → "Work" room created isolated → app lands in it).
>
> **Per-room theme + multi-window (VERIFIED 2026-05-23):** both were already implemented and are now
> confirmed working. `RoomThemeSync` (`src/components/layout/room-theme-sync.tsx`, mounted in
> `layout.tsx`) applies the active room's `room.theme` on switch and on load, falling back to the global
> theme when unset — verified by giving two rooms different themes (matrix vs sakura) and watching the
> CSS change live on switch. "Open in new window" (`src/lib/cabinets/room-window.ts`) opens a second
> window scoped to the room: Electron spawns a native `BrowserWindow` reusing the backend
> (`electron/main.cjs` `cabinet:open-window` IPC + `preload.cjs` `CabinetDesktop.openWindow`), web uses
> `window.open` — verified in-browser (second window opened at `#/cabinet/work` and rendered Work's
> matrix theme independently of the first window's sakura). Each window keeps its own DOM, so per-window
> theme + scope are independent.
>
> **Truly remaining:** none blocking. Existing installs created before this work still migrate via
> `scripts/migrate-rooms-v3.mjs` (idempotent). Minor nit: a brief global-theme flash before the room
> theme paints on a cold load (room theme resolves after the async rooms fetch); acceptable.

> **Why this exists.** v2 kept `data/` as *both* the root cabinet *and* the parent of every
> other room. That makes rooms children of one room, so isolation can only be faked (a UI
> filter + a default visibility setting). The product intent is the opposite: **a room is a big
> cabinet, isolated and alone; Personal and Work must never mix.** This document specifies the
> structural fix and a safe migration. Decision recorded 2026-05-23: go with true sibling rooms.

---

## 1. The model

- **`data/` is a neutral container ("home"), not a cabinet.** It has no `.cabinet`, no agents,
  no tasks of its own.
- **A room is a top-level cabinet: `data/<room>/`,** fully self-contained — its own `.cabinet`,
  `index.md`, `.agents/`, `.jobs/`, `.cabinet-state/`, `.chat/`, and **its own search DB**
  (`.cabinet.db`). No room is the parent of another.
- **Within a room,** nested sub-cabinets work exactly as today (roll-up visibility own / +1 / +2
  / all). **Across rooms: zero knowledge.** Isolation is structural (different subtree, different
  DB), not a UI filter.
- **There is always an active room.** `section.cabinetPath` is always rooted at a room slug
  (`work`, `work/projects/acme`). The first path segment *is* the room. There is no `"."` root
  cabinet anymore.
- **One intentional cross-room thing stays:** `data/.global-agents/` (opt-in shared agents,
  default empty). Everything else is per-room.

### 1.1 Target on-disk layout

```
data/                       ← neutral container (the "home"); marked, but NOT a cabinet
├── .home/                  ← NEW: container-level config (see §3)
│   ├── home.json           ← marker + defaultRoom + lastActiveRoom
│   ├── user.json           ← global: who the user is
│   ├── providers.json      ← global: AI providers configured
│   ├── onboarding-complete.json
│   └── integration-environments.json
├── .global-agents/         ← stays: cross-room shared agents (default empty)
├── .cabinet-state/         ← stays: machine/app state (ports, disclaimer-ack, file-schema)
├── .git/                   ← stays: ONE repo for the whole home (history preserved)
│
├── work/                   ← a room (self-contained cabinet)
│   ├── .cabinet            ← name, kind: room, room:{icon,color,theme}
│   ├── .cabinet.db         ← per-room search index
│   ├── index.md
│   ├── .agents/            ← personas + .conversations/.memory/.messages/.runtime
│   ├── .jobs/
│   ├── .cabinet-state/     ← (optional per-room runtime; see §3)
│   ├── .chat/              ← this room's team channels
│   ├── company.json        ← per-room workspace identity (was in .agents/.config)
│   └── …content…           ← pages, sub-cabinets, getting-started
│
├── personal/               ← another room, fully isolated from `work`
│   └── …same shape…
└── salesons/               ← an existing nested cabinet, now just a sibling room
    └── …same shape…
```

### 1.2 What changed vs. v2

| Concern | v2 (today) | v3 (this doc) |
|---|---|---|
| `data/` | the root cabinet **and** the container | container only |
| A room | top-level dir, *or the root* | top-level dir **with `.cabinet`** only |
| Folders without `.cabinet` | listed as rooms | **not** rooms (they're content of a room) |
| Isolation | UI filter + default "own" visibility | **structural** (separate subtree + separate DB) |
| Search | one shared `data/.cabinet.db` | **one DB per room** |
| Root room | special, parents everything | **gone**; all rooms are equal siblings |
| `section.cabinetPath` `"."` | the root cabinet | **home/no-room** (launcher); rooms start at a slug |

---

## 2. What lives where (authoritative classification)

Derived from the real `data/` on 2026-05-23. This is the migration's move-list.

**Moves INTO the room** (`data/<rootSlug>/`) — these belonged to the old root cabinet:

| Item today | Why | New location |
|---|---|---|
| `data/.cabinet` | the cabinet manifest | `data/<root>/.cabinet` |
| `data/.cabinet.db` (+ `-shm`, `-wal`) | the cabinet's search index | `data/<root>/.cabinet.db*` |
| `data/.agents/<persona>/` | the cabinet's team | `data/<root>/.agents/<persona>/` |
| `data/.agents/.conversations`, `.memory`, `.messages`, `.runtime` | per-cabinet agent runtime | `data/<root>/.agents/…` |
| `data/.agents/.config/company.json`, `workspace.json` | **per-room** workspace identity | `data/<root>/` (or `<root>/.agents/.config/`) |
| `data/.chat/` | the room's team chat | `data/<root>/.chat/` |
| `data/index.md` | the cabinet entry page | `data/<root>/index.md` |
| `data/getting-started/`, `data/songs/` (no `.cabinet`) | the cabinet's **content** | `data/<root>/…` |
| any other plain top-level folder/file | the cabinet's content | `data/<root>/…` |

**STAYS at the container** (`data/`):

| Item | Why |
|---|---|
| `data/.git/` | one repo for the whole home; moving files inside it preserves history |
| `data/.global-agents/` | cross-room shared agents, by design |
| `data/.cabinet-state/` (ports, disclaimer-ack, file-schema) | machine/app-level runtime, not room content |
| `data/.cabinet-meta/audit.log` | app-level audit (could split per-room later; keep container for now) |
| `data/.agents/.config/{user,providers,onboarding-complete,integration-environments}.json` | **global app config** → moved up to `data/.home/` (see §3) |

**Stays in place, becomes a sibling room** (already top-level cabinets):

- `data/salesons/`, `data/dauther/`, `data/fff/` — they already have `.cabinet`. No move; they
  simply stop being "children of the root room" once the root cabinet is gone. They get a fresh
  per-room `.cabinet.db` on first search (lazy reindex). Backfill a `room:` block + `kind: room`.

> **The split that bites:** `data/.agents/.config/` mixes per-room identity (`company`,
> `workspace`) with **global app config** (`user`, `providers`, `onboarding-complete`,
> `integration-environments`). Migration must split it; every reader of
> `DATA_DIR/.agents/.config/<global>.json` must repoint to `data/.home/`.

---

## 3. Container config (`data/.home/`)

New container-level directory so the app can tell "this is a Cabinet home" apart from "a room,"
and so global config survives `.agents/` moving into a room.

```jsonc
// data/.home/home.json
{
  "schemaVersion": 1,
  "kind": "home",
  "defaultRoom": "work",      // slug of the room to open on launch
  "lastActiveRoom": "work"    // last room the user was in (per machine)
}
```

- `user.json`, `providers.json`, `onboarding-complete.json`, `integration-environments.json`
  move here from `.agents/.config/`.
- `.cabinet-state/` (ports, disclaimer-ack, file-schema) is machine/app state and can stay at
  `data/.cabinet-state/` or move under `.home/`. **Proposed:** leave at `data/.cabinet-state/`
  to minimize churn; revisit if it ever needs to be per-room.

---

## 4. Code refactor surface

The hard part is removing the assumption "no `cabinetPath` ⇒ the root cabinet ⇒ `DATA_DIR`."
After v3, **a path resolved with no room must fail loud, not default to root** (PRD §8 risk).

### 4.1 Path / scope

- `ROOT_CABINET_PATH = "."` is retired as "the root cabinet." `"."`/empty now means **no room
  selected** (home launcher). Add `resolveRoomDir(cabinetPath)` that requires a room segment.
- **Audit every `DATA_DIR` reference** (PRD §8 counted ~71). Classify each as:
  - *room-scoped* (agents, tasks, jobs, tree, search, chat, index) → must resolve under the
    active room, never bare `DATA_DIR`;
  - *container-global* (ports, install metadata, library, backups, `.global-agents`, `.home`
    config) → stays bare `DATA_DIR`.
  This audit is the bulk of the work and the main risk; do it as its own pass with tests.

### 4.2 Rooms list

- `src/lib/cabinets/rooms.ts` `listRooms()`: rooms = direct children of `data/` **that have a
  `.cabinet`**. Drop the root entry. Drop the "all folders are rooms" behavior — a folder
  without `.cabinet` is content, never a room (fixes "Songs"/"Getting Started" showing as rooms).
- Keep lazy "promote folder to room" as an explicit action only (writes a `.cabinet`), not implicit.

### 4.3 Tree

- `/api/tree?cabinetPath=<room>` builds the tree **rooted at that room's dir**. It never sees
  sibling rooms (different subtree). Within the room, nested sub-cabinets still render.
- Delete the root-only UI subtraction in `tree-view.tsx:190-196` — no longer needed once the
  tree is rooted per room.

### 4.4 Search

- One `.cabinet.db` **per room**, built from that room's files. Queries hit the active room's DB.
  No prefix-scoping, no cross-room leak. Sibling rooms reindex lazily on first search.

### 4.5 Theme / avatar (room identity)

- Theme: per-room from `.cabinet` `room.theme` (already designed in v2 §5.4; keep).
- **Assign a real `room.icon` + `room.color` at creation** (and let onboarding pick one), so
  rooms don't all collapse to a first-letter tile. Fixes the "one DP" perception.

### 4.6 Creation flows (restore room vs. sub-cabinet)

- **Add room** (top switcher) → creates `data/<slug>/` with `kind: room` + `room:{icon,color,theme}`.
- **New Cabinet** (sidebar bottom, while inside a room) → creates a **sub-cabinet inside the
  current room** at `data/<room>/…/<slug>/` with `kind: child`. Same-room cabinets may roll up;
  this is the "cabinets in the same room can know about each other" the user asked for.
- Stop writing `kind: root` for nested cabinets (today's bug). Kinds: `room` (top-level) /
  `child` (nested).

### 4.7 Onboarding

- Scaffold the first room at `data/<firstRoomSlug>/` (**not** the root in place), write
  `data/.home/home.json` with `defaultRoom`, and ask for the room's icon/color.

---

## 5. Migration

Touches the user's live data, so: idempotent, automatic-with-guard, checkpointed, reversible.

### 5.1 Detection

Old layout iff `data/.cabinet` exists (root is a cabinet) **and** `data/.home/home.json` is
absent. Otherwise no-op.

### 5.2 Algorithm

1. **Preflight:** ensure the daemon has released `data/.cabinet.db` (run at startup before the DB
   opens, or require a restart). Refuse if the DB is locked.
2. **Checkpoint:** `git -C data add -A && git commit` ("pre-rooms-v3 checkpoint"); also write a
   filesystem `data/.home/migration-journal.json` listing every planned move (for resume/rollback).
3. Derive `rootSlug` from `data/.cabinet` `name` (e.g. "sales" → `sales`); de-collide against
   existing top-level dirs.
4. `mkdir data/<rootSlug>/`. **Move** (via `git mv` to preserve history) every item in the §2
   "moves into the room" list into `data/<rootSlug>/`.
5. Split `.agents/.config/`: per-room files into the room; global files into `data/.home/`.
6. Write `data/<rootSlug>/.cabinet` with `kind: room` + a `room:` block (backfill icon/color/theme).
7. For each existing top-level cabinet (`salesons`, `dauther`, `fff`): backfill `kind: room` +
   `room:` block in its `.cabinet`. Leave files in place.
8. Write `data/.home/home.json` (`defaultRoom: <rootSlug>`, `kind: home`).
9. `git -C data add -A && git commit` ("rooms v3 migration").
10. Drop `data/<rootSlug>/.cabinet.db-shm/-wal` staleness; let the room reopen/reindex.

### 5.3 Safety & rollback

- The pre-migration git commit is the rollback point (`git reset --hard` to it).
- Migration is fully **idempotent**: re-running with `.home/home.json` present is a no-op.
- A partial failure leaves the journal; on next start, resume or roll back from it.
- Update any `CABINET_DATA_DIR` / symlinked-knowledge / `.repo.yaml` paths that pointed into the
  old root so links don't break (audit as part of the move).
- Ship as `cabinetai doctor --migrate-rooms` too, for users who prefer to run it manually.

---

## 6. Open questions (small, for review)

1. **Per-room chat** (proposed: move `.chat/` into the room) vs. a global chat. → *Proposed: per-room.*
2. **One git repo at the container** (proposed; preserves history, not a leak) vs. per-room repos.
   → *Proposed: one at container.*
3. **`.cabinet-state` location** — keep at container (proposed) vs. per-room. → *Proposed: container.*
4. **Home/launcher screen** when no room is selected — minimal now (land in `defaultRoom`; the
   home avatar opens the switcher) vs. a full room grid. → *Proposed: minimal now, grid later.*
5. **Default room name** — keep the existing root name (e.g. "sales", renameable) vs. prompt on
   first migrated launch. → *Proposed: keep existing name, renameable in the switcher.*

---

## 7. Phased plan (one coherent pass, staged for safety)

- **Phase 0 — Migration engine + tests.** Detection, journal, `git mv` moves, `.config` split,
  `.home` write, idempotency + rollback tests against a fixture copy of a real `data/`. No UI yet.
- **Phase 1 — Path/scope refactor.** Retire `"."`-as-root; add `resolveRoomDir`; audit the ~71
  `DATA_DIR` sites; make room-scoped resolvers fail loud without a room. This is the riskiest part.
- **Phase 2 — Rooms list + tree + creation.** `listRooms()` requires `.cabinet`; tree rooted per
  room; remove the UI subtraction; split "Add room" vs. "New Cabinet"; correct `kind`.
- **Phase 3 — Per-room search DB.** One DB per room; lazy reindex; queries hit the active room.
- **Phase 4 — Identity + theme.** Assign icon/color at creation; per-room theme on switch; fix
  the avatar so rooms are visually distinct.
- **Phase 5 — Onboarding + home config.** First room under `data/<slug>/`; write `.home/home.json`;
  pick icon/color in onboarding.
- **Phase 6 — Docs.** Update `getting-started/rooms/` (both `resources/getting-started/` and the
  he locale) so the promise ("nothing in one room leaks into another") is now literally true; mark
  `ROOMS_WORKSPACES_PRD.md` as superseded by this doc.

---

*Decision source: product Q&A 2026-05-23 (true sibling rooms with migration; full design before
implementation). This document is the implementation contract; `ROOMS_WORKSPACES_PRD.md` v2 is
superseded.*
