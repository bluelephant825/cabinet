---
title: Connect Knowledge
created: '2026-04-12T00:00:00.000Z'
modified: '2026-06-20T00:00:00.000Z'
tags:
  - guide
  - symlinks
  - knowledge
  - cloud
order: 2
---

# Connect Knowledge

Connect Knowledge brings external folders into your knowledge base without copying anything. The folder stays where it is on disk (or in your cloud sync folder), and Cabinet creates a pointer to it so its contents show up in the sidebar and are available to AI agents as context.

## The picker

Right-click the data area or any folder in the sidebar and choose **Connect Knowledge**. A tile picker opens with your options:

- **Local folder** (symlink) — any folder on your machine.
- **Google Drive, iCloud Drive, OneDrive, SharePoint, Dropbox** — cloud folders, read straight from the provider's desktop sync app (no OAuth, no setup).
- **Notion, Confluence** — these are app connectors, so the tile takes you to the Integrations Hub to connect them there.

If a provider's desktop app is installed, it also shows up under "Detected on this Mac" so you can jump straight to it.

Connections are **per room**: each room keeps its own list, so a folder you connect in one room does not leak into another.

## Local folders (symlinks)

Pick **Local folder**, choose a folder (or paste a path), optionally set a name, and Connect. Cabinet creates a symlink inside the KB:

```
data/my-project -> /Users/me/Projects/my-project
```

The folder's contents appear directly as children in the sidebar tree. No wrapper directories, no extra nesting.

### What gets written

For local folders, Cabinet writes two hidden dotfiles into the **target folder**:

- **`.cabinet-meta`** — display metadata for the KB (title, tags). Hidden from the sidebar.
- **`.repo.yaml`** (git repos only) — Cabinet auto-detects the branch and remote so agents can read the source in context. Skipped if one already exists.

## Cloud folders

Pick a cloud provider (for example **Google Drive**). Cabinet finds the provider's local sync folder, lets you browse into a sub-folder, and lets you choose a **policy**:

- **View only** (default) — agents can read the files, but nothing in Cabinet can change them.
- **Read and write** — edits in Cabinet sync back to the cloud.

There are two ways a cloud folder can appear:

- **Inline** — when you connect from a folder node, the cloud folder mounts right there in the tree (a symlink), with the provider's icon and, for view-only connections, a small "view" badge.
- **Cloud browser** — when you connect from the room root, the folder joins a dedicated browser section for the room.

Native Google Docs, Sheets, and Slides (`.gdoc` / `.gsheet` / `.gslides`) are always view only. They open in a read-only viewer, even inside a read and write folder.

## Sidebar icons

| Icon | Meaning |
|------|---------|
| Orange branch | Linked git repo (has `.repo.yaml`) |
| Blue link | Linked local directory |
| Provider logo (Drive, OneDrive, ...) | A connected cloud folder |
| "view" badge | Read-only connection (view only) |

## Disconnecting

Right-click a connected folder and choose **Unlink** (or **Disconnect** for a cloud mount). This removes only the pointer from the KB. The original folder and all its files are untouched.

## Changing the data directory

By default, Cabinet stores content in `./data` (dev mode) or a platform-specific app-data path (Electron). Override with the `CABINET_DATA_DIR` environment variable:

```bash
CABINET_DATA_DIR=/path/to/my/kb npm run dev
```

You can also make `data/` itself a symlink pointing elsewhere. The tree builder follows symlinks transparently.

## Tips

- Connected folders with an `index.html` (and no `index.md`) render as embedded websites. Add a `.app` marker for full-screen mode.
- If a target folder has its own `index.md`, Cabinet uses it as the landing page.
- Agents discover linked repos by reading `.repo.yaml` in the current or any parent directory.
- Read-only cloud folders open in a view-only editor, so you cannot accidentally change a file the connection is meant to protect.

---

Back to [[Getting Started]]
