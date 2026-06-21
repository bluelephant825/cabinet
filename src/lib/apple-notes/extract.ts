import { execFile } from "child_process";
import { promisify } from "util";

const execFileP = promisify(execFile);

export interface AppleNote {
  /** AppleScript id: x-coredata://<store>/ICNote/p<rowid>. */
  id: string;
  /** The p<rowid> from `id`, = ZICCLOUDSYNCINGOBJECT.Z_PK — the sqlite join key. */
  rowid: number | null;
  name: string;
  /** ISO 8601. */
  created: string;
  /** ISO 8601 — the note's modification date in Notes.app (the upsert key). */
  modified: string;
  /** Container chain, account-first: ["iCloud", "Folder", "Subfolder"]. */
  folders: string[];
  /** Note body as HTML (empty for locked notes). */
  bodyHtml: string;
  locked: boolean;
}

// JXA (JavaScript for Automation): one Apple Events session that reads every
// note and prints a JSON array. Scalar props are fetched in bulk arrays (one
// event each) — the JXA speed trick — and only the folder walk is per-note,
// cached by folder id. JSON.stringify renders Dates as ISO automatically.
// ponytail: single pass loads all bodies into memory; if a huge library
// overflows maxBuffer below, chunk by folder (Notes.folders().forEach).
const JXA = `
function folderPath(folder, cache) {
  if (!folder) return [];
  var segs = [];
  var cur = folder;
  var guard = 0;
  while (cur && guard < 32) {
    guard++;
    var nm;
    try { nm = cur.name(); } catch (e) { break; }
    if (!nm) break;
    segs.unshift(nm);
    var parent = null;
    try { parent = cur.container(); } catch (e) { parent = null; }
    if (!parent) break;
    cur = parent;
  }
  return segs;
}
function run() {
  var Notes = Application('Notes');
  var notes = Notes.notes;
  var ids, names, created, modified, locked, bodies, containers;
  try { ids = notes.id(); } catch (e) { ids = []; }
  var n = ids.length;
  if (!n) return '[]';
  try { names = notes.name(); } catch (e) { names = []; }
  try { created = notes.creationDate(); } catch (e) { created = []; }
  try { modified = notes.modificationDate(); } catch (e) { modified = []; }
  try { locked = notes.passwordProtected(); } catch (e) { locked = []; }
  try { containers = notes.container(); } catch (e) { containers = []; }
  // Bodies may fault on locked notes in a bulk read; fall back per-note.
  try { bodies = notes.body(); } catch (e) { bodies = null; }

  var out = [];
  var fcache = {};
  for (var i = 0; i < n; i++) {
    var isLocked = !!locked[i];
    var body = '';
    if (!isLocked) {
      if (bodies && bodies[i] != null) body = bodies[i];
      else { try { body = Notes.notes[i].body(); } catch (e) { body = ''; } }
    }
    var fp = [];
    try { fp = folderPath(containers[i], fcache); } catch (e) { fp = []; }
    out.push({
      id: ids[i],
      name: names[i] || 'Untitled',
      created: created[i] || null,
      modified: modified[i] || null,
      folders: fp,
      bodyHtml: body || '',
      locked: isLocked,
    });
  }
  return JSON.stringify(out);
}
run();
`;

function rowidFromId(id: string): number | null {
  const m = /\/p(\d+)\b/.exec(id);
  return m ? Number(m[1]) : null;
}

export class AppleNotesPermissionError extends Error {}

/**
 * Read every Apple Note via JXA. macOS only. Throws AppleNotesPermissionError
 * when the host process hasn't been granted Automation access to Notes
 * (TCC error -1743 / "Not authorized to send Apple events").
 */
export async function extractAppleNotes(): Promise<AppleNote[]> {
  if (process.platform !== "darwin") {
    throw new Error("Apple Notes import is only available on macOS.");
  }
  let stdout: string;
  try {
    ({ stdout } = await execFileP("osascript", ["-l", "JavaScript", "-e", JXA], {
      maxBuffer: 512 * 1024 * 1024, // bodies can be large; 512MB headroom
      timeout: 10 * 60 * 1000,
    }));
  } catch (err) {
    const e = err as { message?: string; stderr?: string };
    const msg = `${e?.message ?? ""}\n${e?.stderr ?? ""}` || String(err);
    if (/-1743|not authoriz|assistive|apple events/i.test(msg)) {
      throw new AppleNotesPermissionError(
        "Cabinet needs permission to control Notes. Grant it under System Settings → Privacy & Security → Automation, then try again."
      );
    }
    throw new Error(`Couldn't read Apple Notes: ${msg}`);
  }

  const raw = JSON.parse(stdout.trim() || "[]") as Array<Omit<AppleNote, "rowid">>;
  const now = new Date().toISOString();
  return raw.map((r) => ({
    ...r,
    rowid: rowidFromId(r.id),
    created: r.created || now,
    modified: r.modified || now,
  }));
}
