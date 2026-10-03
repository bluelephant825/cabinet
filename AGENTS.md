# AGENTS.md

Cabinet is a self-hosted, AI-first knowledge base and "startup OS". Knowledge-base content lives as
markdown files on disk; AI agents (backed by local CLI providers) read and
write those files on schedules or on demand. Humans define intent, agents do the work

`docs/AGENTS.md` holds a longer, feature-by-feature ruleset (skills, knowledge sources, registry,
editor). Read it when you touch those subsystems. This file covers the parts you need for almost any
task.

Three processes and a data directory. Understanding the split is most of the battle.

**1. Next.js app
**2. Daemon
**3. Electron shell 

## Browser automation

Cabinet agents use the opt-in AlohaJet integration through `cabinet-browser mcp`
or the equivalent CLI commands. AlohaJet attaches to the existing daemon-owned
Chromium through the private capability bridge; never expose a Chromium debug
port, launch a second agent browser, or write browser MCP entries into user-global
CLI configs. Public downloads and imports are Cabinet-native and must keep the
room path policy, SSRF checks, atomic document persistence, history, and tree
refresh. See `docs/BROWSER.md`.

## PROGRESS.md

After every change to this project, append an entry to `PROGRESS.md`:

```
[YYYY-MM-DD] Brief description of what changed.
```

This is mandatory and is the project's running changelog. Existing entries are detailed (what changed,
why, what was verified) — match that.

Entries must stay in chronological order: oldest at the top, newest at the bottom. Always append new
entries at the end of the file, never prepend them at the top.
