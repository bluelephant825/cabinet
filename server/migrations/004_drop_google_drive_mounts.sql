-- Connect Knowledge moved Google Drive mounts out of this global table and into
-- per-room storage: `<room>/.agents/.config/knowledge-sources.json`
-- (docs/CONNECT_KNOWLEDGE_PRD.md §5 / §9). The global table is the reason the
-- Drive browser leaked across rooms. Existing global rows are intentionally NOT
-- auto-migrated (the "clear them" decision, §9); users reconnect per room.
DROP TABLE IF EXISTS google_drive_mounts;
