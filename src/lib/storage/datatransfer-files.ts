// Expand a drop's DataTransfer into files, recursing into dropped folders
// via webkitGetAsEntry so folder drag-drop works on web/cloud (where the
// native Import Folder picker isn't available).

export interface DroppedFile {
  file: File;
  /** Path of the containing folder relative to the drop target ("" for loose files). */
  relativeDir: string;
}

// ponytail: name-based junk filter only; the upload API already blocks executables.
const SKIP = new Set([".git", ".svn", "node_modules", ".DS_Store", "Thumbs.db"]);

function readAllEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  // readEntries returns at most ~100 entries per call; drain until empty.
  const reader = dir.createReader();
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) return resolve(all);
        all.push(...batch);
        next();
      }, reject);
    next();
  });
}

async function walk(
  entry: FileSystemEntry,
  dir: string,
  out: DroppedFile[]
): Promise<void> {
  if (SKIP.has(entry.name)) return;
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject)
    );
    out.push({ file, relativeDir: dir });
    return;
  }
  if (entry.isDirectory) {
    const children = await readAllEntries(entry as FileSystemDirectoryEntry);
    const childDir = dir ? `${dir}/${entry.name}` : entry.name;
    for (const child of children) await walk(child, childDir, out);
  }
}

/**
 * Must be called synchronously from the drop event handler — DataTransfer
 * items are only readable during the event dispatch, so entries are captured
 * before the first await.
 */
export function filesFromDataTransfer(dt: DataTransfer): Promise<DroppedFile[]> {
  const items = Array.from(dt.items || []).filter((i) => i.kind === "file");
  const entries = items.map((i) => i.webkitGetAsEntry?.() ?? null);
  // Fallback (no entry support): flat file list, folders silently skipped.
  if (!entries.some(Boolean)) {
    return Promise.resolve(
      Array.from(dt.files).map((file) => ({ file, relativeDir: "" }))
    );
  }
  return (async () => {
    const out: DroppedFile[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry) {
        await walk(entry, "", out);
      } else {
        const file = items[i].getAsFile();
        if (file) out.push({ file, relativeDir: "" });
      }
    }
    return out;
  })();
}
