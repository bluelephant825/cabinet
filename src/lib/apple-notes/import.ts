import fs from "fs/promises";
import path from "path";
import matter from "gray-matter";
import { resolveContentPath, sanitizeFilename } from "@/lib/storage/path-utils";
import { fileExists } from "@/lib/storage/fs-operations";
import { writePage } from "@/lib/storage/page-io";
import { htmlToMarkdown } from "@/lib/markdown/to-markdown";
import { invalidateTreeCache } from "@/lib/storage/tree-builder";
import { autoCommit } from "@/lib/git/git-service";
import {
  extractAppleNotes,
  AppleNotesPermissionError,
  type AppleNote,
} from "./extract";
import {
  collectNoteAttachments,
  AppleNotesAttachmentsUnavailable,
  type AttachmentRef,
} from "./attachments";

export { AppleNotesPermissionError };

const IMPORT_ROOT = "Apple Notes";
const IMG_EXT = /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp|svg)$/i;

export interface ExistingPage {
  virtualPath: string;
  modified?: string;
}

/** Pure upsert decision — match on the stable Apple Notes id, newer wins. */
export function chooseAction(
  noteModified: string,
  existing?: ExistingPage
): "create" | "update" | "skip" {
  if (!existing) return "create";
  if (!existing.modified) return "update";
  // ISO-8601 strings compare correctly lexicographically (same producer).
  return noteModified > existing.modified ? "update" : "skip";
}

export type ImportProgress =
  | { type: "extracting" }
  | { type: "extracted"; total: number }
  | { type: "progress"; done: number; total: number; name: string };

export interface ImportSummary {
  created: number;
  updated: number;
  skipped: number;
  skippedLocked: number;
  attachments: number;
  /** Set when images couldn't be read: "fda" | "schema" | "none". */
  attachmentsUnavailable?: string;
  importRoot: string;
}

/**
 * Walk the content tree and index every page that carries an `appleNotes.id`
 * in its frontmatter → so re-import upserts by id (and follows pages the user
 * moved or renamed), instead of duplicating them.
 */
async function buildExistingIndex(): Promise<Map<string, ExistingPage>> {
  const root = resolveContentPath("");
  const index = new Map<string, ExistingPage>();

  async function walk(absDir: string, virtual: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      if (!e.isDirectory()) continue;
      const childVirtual = virtual ? `${virtual}/${e.name}` : e.name;
      const indexMd = path.join(absDir, e.name, "index.md");
      if (await fileExists(indexMd)) {
        try {
          const { data } = matter(await fs.readFile(indexMd, "utf8"));
          const id = data?.appleNotes?.id;
          if (typeof id === "string") {
            index.set(id, { virtualPath: childVirtual, modified: data.appleNotes?.modified });
          }
        } catch {
          /* unreadable frontmatter — skip */
        }
      }
      await walk(path.join(absDir, e.name), childVirtual);
    }
  }

  await walk(root, "");
  return index;
}

function slugSegments(note: AppleNote): string[] {
  return note.folders
    .map((f) => sanitizeFilename(f) || "folder")
    .filter(Boolean);
}

/**
 * Pick a collision-free virtual path for a new note. Only suffixes when the
 * target is a *real different page* (its index.md carries another note's id);
 * a free path or a leftover empty/non-page dir is reused as-is — so writePage
 * can create its index.md inside.
 */
async function freshPath(base: string, noteId: string): Promise<string> {
  let candidate = base;
  let counter = 1;
  for (;;) {
    const abs = resolveContentPath(candidate);
    if (!(await fileExists(abs))) return candidate; // free
    const idx = path.join(abs, "index.md");
    if (!(await fileExists(idx))) return candidate; // empty/non-page dir → reuse
    try {
      const { data } = matter(await fs.readFile(idx, "utf8"));
      if (data?.appleNotes?.id === noteId) return candidate; // it's us — reuse
    } catch {
      /* unreadable — treat as a different page, suffix below */
    }
    candidate = `${base}-${++counter}`;
  }
}

interface AttachmentPlan {
  /** Markdown to append to the body (an `## Attachments` section, or ""). */
  markdown: string;
  /** Files to copy into the page dir once it exists. */
  files: Array<{ srcPath: string; destName: string }>;
}

/**
 * Plan a note's attachments — pure: dedupe destination names and render the
 * markdown refs, but DON'T touch the filesystem. The page dir is created by
 * writePage; copying before that would make writePage mistake the empty dir
 * for the page file (EISDIR). Files are copied in afterwards (copyAttachments).
 */
function planAttachments(refs: AttachmentRef[]): AttachmentPlan {
  const used = new Set<string>();
  const files: AttachmentPlan["files"] = [];
  const lines: string[] = [];
  for (const ref of refs) {
    let name = sanitizeFilename(ref.filename) || "attachment";
    const ext = path.extname(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    let i = 1;
    while (used.has(name)) name = `${stem}-${++i}${ext}`;
    used.add(name);
    files.push({ srcPath: ref.srcPath, destName: name });
    lines.push(IMG_EXT.test(name) ? `![${stem}](${name})` : `[${stem}](${name})`);
  }
  const markdown = lines.length ? `\n\n## Attachments\n\n${lines.join("\n\n")}\n` : "";
  return { markdown, files };
}

/** Copy planned attachment files into the (already-created) page dir. */
async function copyAttachments(
  pageDirAbs: string,
  files: AttachmentPlan["files"]
): Promise<number> {
  let count = 0;
  for (const f of files) {
    try {
      await fs.copyFile(f.srcPath, path.join(pageDirAbs, f.destName));
      count++;
    } catch {
      /* unreadable media — skip */
    }
  }
  return count;
}

/**
 * Import (or re-import) Apple Notes into the tree under `parentPath`. One-way:
 * notes become directory-pages (`<note>/index.md`) under an "Apple Notes"
 * folder, mirroring the Notes folder hierarchy. Re-import upserts by
 * `appleNotes.id` (newer modification date wins) — it never duplicates, and
 * never deletes pages whose notes were removed in Notes.app.
 */
export async function importAppleNotes(
  parentPath = "",
  onProgress: (p: ImportProgress) => void = () => {}
): Promise<ImportSummary> {
  onProgress({ type: "extracting" });
  const notes = await extractAppleNotes();
  onProgress({ type: "extracted", total: notes.length });
  const existing = await buildExistingIndex();

  const cleanParent = parentPath.trim().replace(/^\/+|\/+$/g, "");
  const importRoot = cleanParent ? `${cleanParent}/${IMPORT_ROOT}` : IMPORT_ROOT;

  // Attachments are best-effort: a failure (no Full Disk Access, odd schema)
  // degrades to a text-only import with a reason in the summary.
  let attachmentMap = new Map<number, AttachmentRef[]>();
  let attachmentsUnavailable: string | undefined;
  const rowids = notes.filter((n) => !n.locked && n.rowid != null).map((n) => n.rowid!);
  try {
    attachmentMap = await collectNoteAttachments(rowids);
  } catch (err) {
    if (err instanceof AppleNotesAttachmentsUnavailable) attachmentsUnavailable = err.reason;
    else attachmentsUnavailable = "none";
  }

  const summary: ImportSummary = {
    created: 0,
    updated: 0,
    skipped: 0,
    skippedLocked: 0,
    attachments: 0,
    attachmentsUnavailable,
    importRoot,
  };

  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    onProgress({ type: "progress", done: i + 1, total: notes.length, name: note.name });

    if (note.locked) {
      summary.skippedLocked++;
      continue;
    }

    const prior = existing.get(note.id);
    const action = chooseAction(note.modified, prior);
    if (action === "skip") {
      summary.skipped++;
      continue;
    }

    let virtualPath: string;
    if (prior) {
      virtualPath = prior.virtualPath;
    } else {
      const slug = sanitizeFilename(note.name) || "untitled";
      const base = [importRoot, ...slugSegments(note), slug].join("/");
      virtualPath = await freshPath(base, note.id);
    }

    const refs = note.rowid != null ? attachmentMap.get(note.rowid) ?? [] : [];
    const { markdown: attachMd, files } = planAttachments(refs);

    // writePage creates the page dir + index.md; copy attachments in *after*
    // so the empty dir isn't mistaken for the page file.
    const body = htmlToMarkdown(note.bodyHtml || "");
    await writePage(virtualPath, `${body}${attachMd}`, {
      title: note.name,
      created: note.created,
      appleNotes: { id: note.id, modified: note.modified },
    });
    summary.attachments += await copyAttachments(resolveContentPath(virtualPath), files);

    if (action === "create") summary.created++;
    else summary.updated++;
  }

  invalidateTreeCache();
  autoCommit(importRoot, summary.updated > 0 && summary.created === 0 ? "Update" : "Add");
  return summary;
}
