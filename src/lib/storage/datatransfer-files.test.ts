import { test } from "node:test";
import assert from "node:assert";
import { filesFromDataTransfer } from "./datatransfer-files";

function fileEntry(name: string): FileSystemFileEntry {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (resolve: (f: File) => void) => resolve(new File(["x"], name)),
  } as unknown as FileSystemFileEntry;
}

// Reader hands entries back in batches (like Chrome's ~100-entry pages) so
// the drain loop is exercised.
function dirEntry(name: string, children: FileSystemEntry[]): FileSystemDirectoryEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      const batches = [children.slice(0, 2), children.slice(2), []];
      return {
        readEntries: (resolve: (e: FileSystemEntry[]) => void) =>
          resolve(batches.shift() ?? []),
      };
    },
  } as unknown as FileSystemDirectoryEntry;
}

function dt(items: Array<FileSystemEntry | File | null>): DataTransfer {
  return {
    items: items.map((it) => ({
      kind: "file",
      webkitGetAsEntry: () => (it instanceof File || it === null ? null : it),
      getAsFile: () => (it instanceof File ? it : null),
    })),
    files: items.filter((it): it is File => it instanceof File),
  } as unknown as DataTransfer;
}

test("recurses folders, preserves relative dirs, skips junk, drains batched readers", async () => {
  const folder = dirEntry("docs", [
    fileEntry("a.md"),
    dirEntry(".git", [fileEntry("HEAD")]),
    fileEntry("b.md"),
    dirEntry("sub", [fileEntry("c.md")]),
  ]);
  const out = await filesFromDataTransfer(dt([folder, fileEntry("loose.txt")]));
  assert.deepStrictEqual(
    out.map((d) => ({ name: d.file.name, dir: d.relativeDir })),
    [
      { name: "a.md", dir: "docs" },
      { name: "b.md", dir: "docs" },
      { name: "c.md", dir: "docs/sub" },
      { name: "loose.txt", dir: "" },
    ]
  );
});

test("falls back to flat file list without entry support", async () => {
  const f = new File(["x"], "plain.txt");
  const out = await filesFromDataTransfer(dt([f]));
  assert.deepStrictEqual(
    out.map((d) => ({ name: d.file.name, dir: d.relativeDir })),
    [{ name: "plain.txt", dir: "" }]
  );
});
