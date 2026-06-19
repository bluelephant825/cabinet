# PRD — Connect Knowledge: external & cloud knowledge sources

**Status:** Draft v2 (2026-06-16, revised after review)
**Driver:** Live design review of the #109 Google Drive sidebar. Goal: a per-room knowledge-source model that keeps a dedicated Drive browser **and** lets you mount specific cloud folders inline in the tree via "Connect Knowledge".
**Related:** `docs/SIDEBAR_FILES_PRD.md` (Connect Knowledge / symlinks), PR #109 (Google Drive for Desktop), `project_integrations_hub.md`.

---

## 1. Summary / thesis

Two complementary surfaces, **one** provider model, **all per-room**:

1. **Drive browser** — a dedicated collapsible section (today's behavior: click the Drive icon → it expands → browse your connected Drive). Kept, but made **per-room** and cleaned up (provider icon, no "GOOGLE DRIVE" title, refresh/manage moved into the node's right-click menu).
2. **In-tree connections** — **Connect Knowledge** becomes a provider menu (Local folder · Google Drive · iCloud · SharePoint…). Picking Google Drive opens a picker rooted at your Drive mount; choosing a sub-folder mounts it **inline at the tree node you clicked**, shown with the Drive icon. This is a **symlink**, so it's per-room for free.

Both surfaces share the same provider registry, mount detection, folder picker, file viewers, and read/write policy. The current **global** `google_drive_mounts` SQLite table is replaced by **per-room** storage so the browser shows only what you connected in that room.

### What "the SQLite table" is (and why it changes)
`.cabinet.db` is a small bookkeeping database at the data root. #109 added a `google_drive_mounts` table — one row per connected Drive folder (`abs_path`, `folder_name`, `enabled`, `added_at`); it's just the registry the bottom section reads to know what to show. It is **global** (one file, no room column), which is exactly why Drive currently leaks across rooms. We move this registry **into each room** (see §5).

---

## 2. Goals & non-goals

### Goals
- Keep a **dedicated, collapsible Drive browser** in the sidebar, but **per-room** and visually cleaned up.
- **Connect Knowledge → Google Drive** mounts a chosen Drive sub-folder **inline in the tree** with the Drive icon (a symlink).
- Everything **per-room** by construction.
- A **provider abstraction** (Local, Google Drive now; iCloud, OneDrive/SharePoint as disabled "coming soon" entries) so new providers are config, not a subsystem.
- **Per-connection read/write toggle** (default read-only).
- Agents read connected folders as knowledge/context.

### Non-goals (v1)
- OAuth/API cloud access — we read the provider's **desktop-sync local folder**; no Google Cloud project / Graph API.
- Real-time cloud change notifications (manual + tree-reload refresh is enough).
- Editing **native cloud documents** in place (Google Docs/Sheets/Slides pointer files; §7).
- A general per-room framework for **MCP** connectors (separate effort).

---

## 3. Current state

| | Connect Knowledge (symlink) | Google Drive (#109) |
| --- | --- | --- |
| Appears | Inline at chosen tree node | Separate pinned bottom section |
| Scope | **Per-room** (symlink in room dir) | **Global** (`google_drive_mounts` in global `.cabinet.db`) |
| Tree component | Normal `TreeNode` | Bespoke `GoogleDriveTreeSection` / `DriveNode` |
| Context menu | Full regular menu | 2 items (Copy path, Reveal) |
| Refresh / manage | n/a | Buttons in a section header |
| Read/write | Read-write | Read-only |

We keep #109's *concept* (a Drive browser) but rebuild storage (per-room), display (cleaned up, provider icon, regular menu), and add the in-tree symlink path.

---

## 4. Key insight — cloud sources are local mounts

Desktop sync apps expose the cloud as a **local directory**, so a "cloud connection" is just a path we can browse and symlink:

| Provider | macOS local mount | Windows |
| --- | --- | --- |
| Google Drive for Desktop | `~/Library/CloudStorage/GoogleDrive-<email>/My Drive` | drive letter `G:\` / `~\My Drive` |
| iCloud Drive | `~/Library/Mobile Documents/com~apple~CloudDocs` | `%USERPROFILE%\iCloudDrive` |
| OneDrive / SharePoint | `~/Library/CloudStorage/OneDrive-<org>` | `%USERPROFILE%\OneDrive - <org>` |
| Dropbox | `~/Library/CloudStorage/Dropbox` / `~/Dropbox` | `%USERPROFILE%\Dropbox` |

Most live under `~/Library/CloudStorage/<Provider>-<account>` on modern macOS — one directory to scan to auto-detect every installed provider/account.

---

## 5. Per-room storage (replaces the global table)

Each room owns its connected sources. Store them in the room's own config:

`data/<room>/.agents/.config/knowledge-sources.json`
```jsonc
{
  "sources": [
    {
      "id": "ks_abc",
      "provider": "google-drive",
      "absPath": "~/Library/CloudStorage/GoogleDrive-you@x/My Drive/Projects",
      "name": "Projects",
      "policy": "read-only",          // per-connection (§6.1)
      "surface": "browser",            // "browser" → bottom section; "inline" → symlink node
      "treePath": "Marketing/Refs"     // for inline: where in the tree it's mounted
    }
  ]
}
```

- **Browser entries** (`surface: "browser"`) render in the per-room Drive section.
- **Inline entries** (`surface: "inline"`) are realized as a **symlink** at `treePath`; the JSON is the source of record (provider, policy, display) since a bare symlink can't carry it (mirrors today's `.cabinet-meta`).
- Rooms-v3 consistency: a room's entire state lives in its directory; no global DB row. (Alternative considered: add a `cabinet_path` column to the existing table — simpler but keeps cross-room state in the global DB, against rooms-v3.)

---

## 6. UX

### F1 — Connect Knowledge as a provider menu
Right-click a folder / room root → **Connect Knowledge…** →

```
Connect Knowledge…
  ├─ Local folder…            (symlink — today's behavior)
  ├─ Google Drive…            (detected: you@x · pick a folder)
  ├─ iCloud Drive…            (disabled — "Coming soon")
  └─ SharePoint / OneDrive…   (disabled — "Coming soon")
```
Active providers open a **folder picker rooted at the provider's mount**; pick any sub-folder. iCloud / OneDrive are shown **disabled** with a "Coming soon" hint (consistent with the Integrations Hub gate).

### F2 — Inline mount
The chosen folder appears as a normal expandable node **at the clicked location**, with the provider icon (Drive cloud mark) and a muted policy badge ("view" when read-only). It uses the **regular tree-node context menu** (the "mirror regular files" decision), with edit/delete/move gated by policy (§6.1). "Edit Symlink" / "Disconnect" reuse the existing symlink editor.

### F3 — Per-room Drive browser (kept, cleaned up)
A dedicated collapsible **Drive** node (not a divider/title). Click the Drive icon → expands to browse connected Drive root(s) for **this room**. Right-click (or a hover affordance) on it exposes **Refresh**, **Add Drive folder…**, and **Manage** (opens the Hub Drive page). No "GOOGLE DRIVE" header text, no header buttons.

### 6.1 Read/write policy — per-connection toggle (decided)
At connect time choose **Read-only** (default) or **Read-write**:
- **Read-only:** view + agent-read; rename/delete/move/edit disabled on the node; native docs always view-only.
- **Read-write:** full parity; edits sync to the cloud (a delete in Cabinet = a delete in Drive — confirm-guarded).
Stored as `policy` per source (§5). Plain `local` symlinks default to read-write (unchanged).

---

## 7. Native cloud documents
Google Docs/Sheets/Slides are pointer files (`.gdoc`/`.gsheet`/`.gslides`). #109 already detects these (`frontmatter.google.kind`) and shows a read-only view; keep that — native docs are **always view-only** (open via web URL / inline read-only viewer) regardless of folder policy. iCloud/SharePoint native types handled per provider, view-only.

---

## 8. Agent access
Connected folders are normal tree content → agents in that room see them as knowledge/context. Writes follow §6.1 (read-only connections are not agent-writable). Note in the editor persona that native cloud docs are view-only.

---

## 9. Migration from #109
- Replace the global `google_drive_mounts` table with per-room `knowledge-sources.json` (§5). Existing global rows are **not** auto-migrated (the earlier "clear them" decision); users re-connect per room.
- Keep #109's reusable parts: `detect-desktop.ts`, the Drive file serving + native-doc viewers, the folder-browse API (now writes per-room sources), and the **Integrations Hub Drive page** — which **stays connectable** but re-points `GoogleDriveSection` at the per-room registry/picker (connects into the active room; §10.5).
- Remove `GoogleDriveTreeSection`'s divider/title + header buttons; fold its rendering into the per-room browser node.

---

## 10. Provider registry
```ts
interface KnowledgeProvider {
  id: "local" | "google-drive" | "icloud" | "sharepoint" | "dropbox";
  label: string;
  icon: string;
  enabled: boolean;                 // false → shown disabled ("Coming soon")
  detect(): Promise<{ root: string; account?: string }[]>;  // [] if not installed
  defaultPolicy: "read-only" | "read-write";
  nativeDocs?: boolean;
}
```
v1 enabled: `local`, `google-drive`. Present-but-disabled: `icloud`, `sharepoint`.

---

## 10.5 Integrations Hub vs Connect Knowledge (the boundary)

These are two different things and should not both "connect" the same provider:

- **Integrations Hub** = **MCP / API connectors** — the agent gains a *capability/tool* (Slack post, GitHub issues, Notion API, Telegram). Connection writes CLI/MCP config + credentials.
- **Connect Knowledge** (sidebar) = **file/folder knowledge sources** mounted into the tree (Local, Google Drive, iCloud, SharePoint, Dropbox, Box). Connection creates a per-room symlink; no API, no credentials.

Today the Hub's Google Drive tile is *connectable* (its detail page embeds `GoogleDriveSection`, the live folder-picker/mount UI at `integration-detail-page.tsx:139`), so you can mount Drive folders from the Hub. The other storage tiles (OneDrive, SharePoint, Dropbox, Box) are gated "Soon" and not connectable.

**Resolution (decided):** **keep Drive connectable in BOTH surfaces.** The overlap is intentional — discoverability differs (some users start in the Hub, some in the sidebar) and both paths land on the same per-room provider model. So:

- **Sidebar / Connect Knowledge** is the primary, in-tree mount path (picker → inline symlink, per-connection policy).
- **Integrations Hub Drive tile** stays connectable: its detail page keeps a connect affordance, but it is **re-pointed at the same per-room registry and folder-picker** as Connect Knowledge (no separate global-table code path). When done from the Hub, a connection lands in the **currently active room** and shows up in that room's sidebar browser.
- The other storage tiles (OneDrive/SharePoint/Dropbox/Box) remain gated "Soon" until their providers ship (§12 P1/P2).

This re-pointing happens **as part of P0** (alongside the per-room registry), so there is never a moment where the Hub connects to the old global table while the sidebar uses the new one — both move together.

## 11. Open questions
1. **Browser node placement:** keep it pinned at the sidebar **bottom**, or render it as a top-level tree node alongside cabinets? (Leaning: keep bottom, but as a clean node, not a divider.)
2. **One Drive root vs many per room:** can a room connect multiple Drive roots/accounts to the browser, or just one?
3. **Inline vs browser overlap:** if a folder is both browsable (root connected) and symlinked inline elsewhere, dedupe in search? (Leaning: allow both; search dedupes by real path.)
4. **Disconnect wording:** "Disconnect" removes the symlink / source entry only, never touches cloud files — confirm copy + guard.
5. **Detection:** auto-scan `~/Library/CloudStorage/*` to list all detected providers/accounts at once, or detect per provider on demand?

**Resolved:** ~~Hub storage scope~~ → keep Drive connectable in **both** the Hub and the sidebar (§10.5). ~~Timing~~ → re-point the Hub to the per-room registry **as part of P0** (no explainer-only step).

---

## 12. Phasing
- **P0:** Provider registry + per-room `knowledge-sources.json`. Connect Knowledge menu with **Local** (existing) + **Google Drive** (picker → inline symlink, per-connection policy). Per-room **Drive browser** node (cleaned up, refresh/manage in right-click). iCloud / OneDrive shown **disabled**. Hub Drive tile stays connectable but re-pointed at the per-room registry (connects into the active room; §10.5). Remove global table + bottom-section chrome.
- **P1:** iCloud + OneDrive/SharePoint detectors + connect (flip `enabled`).
- **P2:** Dropbox; auto-scan CloudStorage for one-click "connect detected account"; native-doc viewer parity.
- **Later:** API/OAuth providers (no desktop app); change-watch / auto-refresh.
