import fs from "fs/promises";
import path from "path";
import matter from "gray-matter";
import yaml from "js-yaml";
import { CABINET_LINK_META_CANDIDATES } from "@/lib/cabinets/files";
import type { PageData, FrontMatter } from "@/types";
import { parseGoogleNative } from "@/lib/google-drive/native-docs";
import { resolveContentPath } from "./path-utils";
import {
  readFileContent,
  writeFileContent,
  ensureDirectory,
  fileExists,
  deleteFileOrDir,
  unlinkSymlink,
} from "./fs-operations";
import {
  appendOrder,
  computeInsertOrder,
  removeSidecarEntry,
  setEntryOrder,
} from "./order-store";
import {
  scanCabinet,
  rewriteReferencesForRename,
  type RewriteResult,
} from "./references";
import { recordRenameUndo } from "./rename-undo";
import { slugifyPageName } from "@/lib/markdown/wiki-links";
import { containsApprovedMdx } from "@/lib/mdx/jsx";

const PAGE_EXTENSIONS = [".md", ".mdx"] as const;

function pageExtension(filePath: string): ".md" | ".mdx" | null {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".md" || ext === ".mdx" ? ext : null;
}

function withPageExtension(filePath: string, ext: ".md" | ".mdx"): string {
  const current = pageExtension(filePath);
  return current ? `${filePath.slice(0, -current.length)}${ext}` : `${filePath}${ext}`;
}

async function firstExisting(paths: string[]): Promise<string | null> {
  for (const candidate of paths) {
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

async function findIndexPage(dirPath: string): Promise<string | null> {
  return firstExisting(PAGE_EXTENSIONS.map((ext) => path.join(dirPath, `index${ext}`)));
}

async function findStandalonePage(basePath: string): Promise<string | null> {
  const explicit = pageExtension(basePath);
  if (explicit) return (await fileExists(basePath)) ? basePath : null;
  return firstExisting(PAGE_EXTENSIONS.map((ext) => `${basePath}${ext}`));
}

function readOnlyError(filePath: string): NodeJS.ErrnoException {
  const error = new Error(`Page is read-only: ${filePath}`) as NodeJS.ErrnoException;
  error.code = "EACCES";
  return error;
}

async function preflightWritable(filePath: string, stat?: import("fs").Stats): Promise<void> {
  const currentStat = stat ?? await fs.stat(filePath);
  if ((currentStat.mode & 0o222) === 0) throw readOnlyError(filePath);
  await fs.access(filePath, (await import("fs")).constants.W_OK);
}

async function preflightWritableDirectory(dirPath: string): Promise<void> {
  const stat = await fs.stat(dirPath);
  if ((stat.mode & 0o222) === 0) throw readOnlyError(dirPath);
  await fs.access(dirPath, (await import("fs")).constants.W_OK);
}

/**
 * Replace a page or convert its extension without ever exposing partial bytes.
 * Hard-linking the complete temp file to a new extension is an atomic,
 * no-clobber create; the old name is removed only after that succeeds.
 */
async function commitPageFile(
  sourcePath: string | null,
  targetPath: string,
  content: string
): Promise<void> {
  const dirPath = path.dirname(targetPath);
  await ensureDirectory(dirPath);

  let sourceStat: import("fs").Stats | null = null;
  if (sourcePath) {
    sourceStat = await fs.stat(sourcePath);
    await preflightWritable(sourcePath, sourceStat);
  }
  await preflightWritableDirectory(dirPath);

  const tempPath = path.join(
    dirPath,
    `.${path.basename(targetPath)}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  );
  let targetCreated = false;

  try {
    await fs.writeFile(tempPath, content, {
      encoding: "utf8",
      flag: "wx",
      mode: sourceStat ? sourceStat.mode & 0o7777 : 0o666,
    });
    if (sourceStat) await fs.chmod(tempPath, sourceStat.mode & 0o7777);

    if (sourcePath === targetPath) {
      await fs.rename(tempPath, targetPath);
      return;
    }

    // link(2) fails with EEXIST instead of POSIX rename's silent overwrite.
    await fs.link(tempPath, targetPath);
    targetCreated = true;

    if (sourcePath) {
      try {
        await fs.unlink(sourcePath);
      } catch (error) {
        // Restore the pre-conversion identity before surfacing the failure.
        try {
          await fs.unlink(targetPath);
          targetCreated = false;
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `Failed to remove the source and roll back ${path.basename(targetPath)}`
          );
        }
        throw error;
      }
    }
  } catch (error) {
    if (targetCreated) await fs.unlink(targetPath).catch(() => {});
    throw error;
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

function defaultFrontmatter(title: string): FrontMatter {
  const now = new Date().toISOString();
  return { title, created: now, modified: now, tags: [] };
}

type ResolvedPageEntry = {
  fsPath: string;
  virtualName: string;
};

function joinVirtualPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function isDescendantPath(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function shouldFallbackMove(error: unknown): error is NodeJS.ErrnoException {
  if (!(error instanceof Error)) return false;
  return ["EXDEV", "EPERM", "EACCES"].includes(
    (error as NodeJS.ErrnoException).code ?? ""
  );
}

async function resolveExistingPageEntry(
  virtualPath: string
): Promise<ResolvedPageEntry> {
  const resolved = resolveContentPath(virtualPath);

  if (await fileExists(resolved)) {
    return {
      fsPath: resolved,
      virtualName: path.basename(resolved),
    };
  }

  const pagePath = await findStandalonePage(resolved);
  if (pagePath) {
    return {
      fsPath: pagePath,
      virtualName: pageExtension(resolved)
        ? path.basename(pagePath)
        : path.basename(pagePath, pageExtension(pagePath) ?? undefined),
    };
  }

  throw new Error(`Page not found: ${virtualPath}`);
}

async function moveResolvedEntry(
  fromResolved: string,
  toResolved: string
): Promise<void> {
  try {
    await fs.rename(fromResolved, toResolved);
    return;
  } catch (error) {
    if (!shouldFallbackMove(error)) {
      throw error;
    }
  }

  const sourceStat = await fs.lstat(fromResolved);

  if (sourceStat.isSymbolicLink()) {
    const target = await fs.readlink(fromResolved);
    const symlinkTarget = path.isAbsolute(target)
      ? target
      : path.relative(
          path.dirname(toResolved),
          path.resolve(path.dirname(fromResolved), target)
        );
    const targetStat = await fs.stat(fromResolved).catch(() => null);
    const symlinkType = process.platform === "win32"
      ? (targetStat?.isDirectory() ? "junction" : "file")
      : undefined;
    await fs.symlink(symlinkTarget, toResolved, symlinkType);
    await fs.unlink(fromResolved);
    return;
  }

  await fs.cp(fromResolved, toResolved, {
    recursive: sourceStat.isDirectory(),
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
  });

  if (sourceStat.isDirectory()) {
    await fs.rm(fromResolved, { recursive: true, force: true });
  } else {
    await fs.unlink(fromResolved);
  }
}

export async function readPage(virtualPath: string): Promise<PageData> {
  const resolved = resolveContentPath(virtualPath);

  // Directory and standalone pages keep one virtual identity regardless of
  // whether their storage extension is .md or .mdx.
  const indexPath = await findIndexPage(resolved);
  const standalonePath = await findStandalonePage(resolved);

  let filePath: string | null = null;
  if (indexPath) {
    filePath = indexPath;
  } else if (standalonePath) {
    filePath = standalonePath;
  } else if (await fileExists(resolved)) {
    // Could be a raw file or a directory — check for linked-folder metadata fallback.
    const stat = await fs.stat(resolved);
    if (stat.isFile()) {
      filePath = resolved;
    }
  }

  if (filePath) {
    // Google Workspace shortcut (.gdoc/.gsheet/…) → return Google frontmatter so
    // the GoogleDocViewer renders it (e.g. native docs inside an inline mount).
    const native = await parseGoogleNative(filePath);
    if (native) {
      const nativeParent = virtualPath.includes("/")
        ? virtualPath.slice(0, virtualPath.lastIndexOf("/"))
        : "";
      return {
        path: virtualPath,
        assetBase: nativeParent,
        content: "",
        frontmatter: {
          title: path
            .basename(virtualPath)
            .replace(/\.(gdoc|gsheet|gslide|gslides|gform)$/i, ""),
          created: new Date().toISOString(),
          modified: new Date().toISOString(),
          tags: [],
          google: { kind: native.kind, url: native.url },
        },
      };
    }

    const raw = await readFileContent(filePath);
    const { data, content } = matter(raw);

    // Directory pages (index.md/index.mdx) keep assets inside the directory,
    // so relative refs resolve against the page path itself. Standalone pages
    // keep assets as siblings of the file, so refs resolve against the
    // parent directory ("" = data root).
    const isDirectoryPage = filePath === indexPath;
    const parentDir = virtualPath.includes("/")
      ? virtualPath.slice(0, virtualPath.lastIndexOf("/"))
      : "";

    return {
      path: virtualPath,
      assetBase: isDirectoryPage ? virtualPath : parentDir,
      content: content.trim(),
      frontmatter: {
        title: data.title || path.basename(virtualPath).replace(/\.mdx?$/i, ""),
        created: data.created || new Date().toISOString(),
        modified: data.modified || new Date().toISOString(),
        tags: data.tags || [],
        icon: data.icon,
        order: data.order,
        dir: data.dir,
        google: data.google,
        appleNotes: data.appleNotes,
      },
    };
  }

  // Fallback for linked directories without index.md.
  for (const filename of CABINET_LINK_META_CANDIDATES) {
    const cabinetMetaPath = path.join(resolved, filename);
    if (!(await fileExists(cabinetMetaPath))) continue;

    const raw = await readFileContent(cabinetMetaPath);
    const meta = yaml.load(raw) as Record<string, unknown>;
    return {
      path: virtualPath,
      content:
        (meta.description as string) ||
        "This folder is linked from an external directory.",
      frontmatter: {
        title: (meta.title as string) || path.basename(virtualPath),
        created: (meta.created as string) || new Date().toISOString(),
        modified: (meta.created as string) || new Date().toISOString(),
        tags: (meta.tags as string[]) || [],
      },
    };
  }

  throw new Error(`Page not found: ${virtualPath}`);
}

/**
 * Heuristic: if a doc's text is mostly Hebrew letters, return "rtl". Used to
 * auto-set frontmatter.dir on agent-generated notes so they render RTL on
 * load. Examines the first ~600 chars to avoid scanning huge files.
 */
function inferDirFromText(content: string): "rtl" | undefined {
  const sample = content.slice(0, 600);
  // Hebrew block: U+0590–U+05FF. Stop counting at 600 chars sampled.
  const hebrewMatches = sample.match(/[֐-׿]/g);
  const letterMatches = sample.match(/[A-Za-z֐-׿]/g);
  if (!hebrewMatches || !letterMatches) return undefined;
  return hebrewMatches.length / letterMatches.length > 0.5 ? "rtl" : undefined;
}

export async function writePage(
  virtualPath: string,
  content: string,
  frontmatter: Partial<FrontMatter>
): Promise<void> {
  const resolved = resolveContentPath(virtualPath);

  const indexPath = await findIndexPage(resolved);
  const standalonePath = await findStandalonePage(resolved);

  let filePath: string;
  if (indexPath) {
    filePath = indexPath;
  } else if (standalonePath) {
    filePath = standalonePath;
  } else if (await fileExists(resolved)) {
    filePath = resolved;
  } else {
    // New virtual pages retain the existing directory-page default.
    filePath = path.join(resolved, "index.md");
  }

  // Auto-detect RTL when the writer didn't set `dir` explicitly and the
  // content reads as Hebrew. Saves Hebrew users from manually toggling the
  // editor RTL button on every agent-generated note.
  const effectiveFrontmatter: Partial<FrontMatter> =
    frontmatter.dir === undefined
      ? { ...frontmatter, dir: inferDirFromText(content) }
      : frontmatter;

  // Strip undefined values — js-yaml cannot serialize them
  const fm = Object.fromEntries(
    Object.entries({ ...effectiveFrontmatter, modified: new Date().toISOString() })
      .filter(([, v]) => v !== undefined)
  );
  const output = matter.stringify(content, fm);
  const currentExtension = pageExtension(filePath);
  const desiredExtension = containsApprovedMdx(content) ? ".mdx" : ".md";
  const targetPath = currentExtension
    ? withPageExtension(filePath, desiredExtension)
    : filePath;

  // An opposite-extension file represents the same virtual page. Never replace
  // it silently, even though rename(2) would overwrite it on POSIX.
  if (targetPath !== filePath && (await fileExists(targetPath))) {
    throw new Error(
      `Cannot convert page: both ${path.basename(filePath)} and ${path.basename(targetPath)} exist`
    );
  }

  const sourceExists = await fileExists(filePath);
  await commitPageFile(sourceExists ? filePath : null, targetPath, output);
}

/**
 * Make `dirPath` (a page's container directory, absolute) able to hold
 * sub-pages. A standalone `.md` or `.mdx` page is promoted to an index file
 * with the same extension, retaining both its content and MDX classification.
 */
export async function ensureContainerDir(dirPath: string): Promise<void> {
  const pagePath = await findStandalonePage(dirPath);
  if (!pagePath || (await findIndexPage(dirPath))) return;
  const ext = pageExtension(pagePath) ?? ".md";
  const indexPath = path.join(dirPath, `index${ext}`);
  await ensureDirectory(dirPath);
  await moveResolvedEntry(pagePath, indexPath);
}

export async function createPage(
  virtualPath: string,
  title: string
): Promise<void> {
  // A sub-page under a standalone page must first turn that page into a
  // container; otherwise the new `<parent>/` dir shadows and orphans the
  // original `<parent>.md`. Do this before creating the child directory.
  const parentVirtual = virtualPath.split("/").slice(0, -1).join("/");
  if (parentVirtual) await ensureContainerDir(resolveContentPath(parentVirtual));

  const resolved = resolveContentPath(virtualPath);
  const dirPath = resolved;
  const filePath = path.join(dirPath, "index.md");

  if ((await findIndexPage(dirPath)) || (await findStandalonePage(resolved))) {
    throw new Error(`Page already exists: ${virtualPath}`);
  }

  await ensureDirectory(dirPath);
  const order = await appendOrder(parentVirtual);
  const fm: FrontMatter & { order?: number } = {
    ...defaultFrontmatter(title),
    order,
  };
  const output = matter.stringify(`\n# ${title}\n`, fm);
  await writeFileContent(filePath, output);
}

export async function deletePage(virtualPath: string): Promise<void> {
  const entry = await resolveExistingPageEntry(virtualPath);
  const stat = await fs.lstat(entry.fsPath).catch(() => null);
  if (stat?.isSymbolicLink()) {
    await unlinkSymlink(entry.fsPath);
  } else {
    await deleteFileOrDir(entry.fsPath);
  }
}

// Hidden dirs scaffolded next to every cabinet (cabinet-scaffold.ts:95-97).
// A "hollow orphan" is a destination that contains only these dirs and they
// in turn hold zero files — the daemon's leftovers from a prior cabinet move,
// not real user content. An empty user-created folder with the same slug as
// the moving item must NOT match (no scaffolding present).
const CABINET_SCAFFOLD_NAMES = new Set([".agents", ".jobs", ".cabinet-state"]);

async function isHollowOrphanDir(dir: string): Promise<boolean> {
  let topEntries;
  try {
    topEntries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  if (topEntries.length === 0) return false;
  for (const e of topEntries) {
    if (!e.isDirectory()) return false;
    if (!CABINET_SCAFFOLD_NAMES.has(e.name)) return false;
  }
  const stack = topEntries.map((e) => path.join(dir, e.name));
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (e.isDirectory()) stack.push(path.join(current, e.name));
      else return false;
    }
  }
  return true;
}

export async function movePage(
  fromPath: string,
  toParentPath: string,
  options: { prevName?: string | null; nextName?: string | null } = {}
): Promise<string> {
  // resolveExistingPageEntry resolves the real on-disk source — including the
  // standalone-".md" case the tree-builder addresses extension-less (it returns
  // virtualName with ".md" stripped), and symlink-backed entries — so the move
  // below doesn't ENOENT and the returned virtual path keeps the right shape.
  const fromEntry = await resolveExistingPageEntry(fromPath);
  const toDir = toParentPath
    ? resolveContentPath(toParentPath)
    : resolveContentPath("");
  const toResolved = path.join(toDir, path.basename(fromEntry.fsPath));
  const name = fromEntry.virtualName;

  const fromParentVirtual = fromPath.split("/").slice(0, -1).join("/");
  const isReorder = fromEntry.fsPath === toResolved;

  if (!isReorder && isDescendantPath(fromEntry.fsPath, toResolved)) {
    throw new Error("Cannot move a page into itself");
  }

  if (!isReorder) {
    const sourceExt = pageExtension(fromEntry.fsPath);
    const sourceStat = await fs.lstat(fromEntry.fsPath);
    const virtualBase = sourceExt
      ? path.basename(fromEntry.fsPath, sourceExt)
      : path.basename(fromEntry.fsPath);
    const identityCollision = sourceExt
      ? await firstExisting([
          path.join(toDir, virtualBase),
          ...PAGE_EXTENSIONS.map((ext) => path.join(toDir, `${virtualBase}${ext}`)),
        ].filter((candidate) => candidate !== toResolved))
      : sourceStat.isDirectory()
        ? await firstExisting(PAGE_EXTENSIONS.map((ext) => path.join(toDir, `${virtualBase}${ext}`)))
        : null;
    if (identityCollision || (await fileExists(toResolved))) {
      // Destination may be empty .agents/ scaffolding the daemon recreated at
      // the old path after a prior cabinet move — sweep it so rename succeeds.
      if (await isHollowOrphanDir(toResolved)) {
        const fsp = await import("fs/promises");
        await fsp.rm(toResolved, { recursive: true, force: true });
      } else {
        throw new Error(
          `An item named "${name}" already exists in ${
            toParentPath ? `"${toParentPath}"` : "the root"
          }. Rename or remove it first.`
        );
      }
    }
    await ensureDirectory(toDir);
    await moveResolvedEntry(fromEntry.fsPath, toResolved);
    await removeSidecarEntry(fromParentVirtual, fromEntry.virtualName).catch(() => {});
  }

  const { prevName, nextName } = options;
  if (prevName !== undefined || nextName !== undefined) {
    const order = await computeInsertOrder(
      toParentPath,
      prevName ?? null,
      nextName ?? null,
      name
    );
    await setEntryOrder(toParentPath, name, order);
  } else if (!isReorder) {
    // Cross-dir move with no neighbors → append at end.
    const order = await appendOrder(toParentPath);
    await setEntryOrder(toParentPath, name, order);
  }

  // fromEntry.virtualName already mirrors the tree-builder shape (standalone
  // page files addressed without their extension), so join it to the destination parent.
  return joinVirtualPath(toParentPath, fromEntry.virtualName);
}

export interface RenameReferencesSummary {
  linkCount: number;
  pageCount: number;
  undoToken: string | null;
  oldName: string;
  newName: string;
  /** Virtual page paths whose markdown was rewritten (no contents) — lets the
   * client refresh an open referrer without a blocking dialog. */
  changedPages: string[];
}

export interface RenameResult {
  newPath: string;
  references: RenameReferencesSummary;
}

export async function renamePage(
  virtualPath: string,
  newName: string
): Promise<RenameResult> {
  const fromResolvedVirtual = resolveContentPath(virtualPath);
  const parentDir = path.dirname(fromResolvedVirtual);
  const parentVirtual = virtualPath.split("/").slice(0, -1).join("/");

  // Tree-builder produces three virtual-path shapes (see tree-builder.ts):
  //   • directories (page-dir, cabinet, app, website): parent/<name>
  //   • standalone .md/.mdx files:                     parent/<name>      (extension stripped)
  //   • typed files (pdf, csv, docx, …):               parent/<name>.<ext>
  // Resolve which one we're actually renaming so the extension survives the
  // round-trip — otherwise foo.csv becomes "foo" and disappears from the
  // sidebar (no classifier matches an extensionless file).
  type RenameKind = "directory" | "page-file" | "typed-file";
  let kind: RenameKind;
  let fromResolved = fromResolvedVirtual;
  let preservedExt = "";

  const directStat = await fs.lstat(fromResolvedVirtual).catch(() => null);
  if (directStat) {
    if (directStat.isDirectory()) {
      kind = "directory";
    } else {
      preservedExt = path.extname(fromResolvedVirtual);
      kind = pageExtension(fromResolvedVirtual) ? "page-file" : "typed-file";
    }
  } else {
    const standalonePath = await findStandalonePage(fromResolvedVirtual);
    if (!standalonePath) throw new Error(`Page not found: ${virtualPath}`);
    fromResolved = standalonePath;
    kind = "page-file";
    preservedExt = pageExtension(standalonePath) ?? ".md";
  }

  const slug = slugifyPageName(newName);
  if (!slug) {
    throw new Error(`Invalid name: "${newName}"`);
  }
  const targetBase = kind === "directory" ? slug : `${slug}${preservedExt}`;
  const toResolved = path.join(parentDir, targetBase);

  // Wiki-links only resolve to markdown page identities, so oldSlug only needs
  // to be meaningful for directory and page-file kinds; typed files cannot
  // match a link.
  const oldSlug =
    kind === "page-file"
      ? path.basename(fromResolved, preservedExt)
      : path.basename(fromResolvedVirtual);

  // Locate the file that carries the page's frontmatter title (index.md/mdx for
  // directory pages, the file itself for standalone pages, nothing for typed
  // files). Snapshot its bytes for Undo and for the toast's old name.
  const titleHostBefore =
    kind === "directory"
      ? await findIndexPage(fromResolved)
      : kind === "page-file"
        ? fromResolved
        : null;
  let titleHostBytes: string | null = null;
  let oldName =
    kind === "typed-file"
      ? path.basename(fromResolvedVirtual, preservedExt)
      : oldSlug;
  if (titleHostBefore && (await fileExists(titleHostBefore))) {
    titleHostBytes = await readFileContent(titleHostBefore);
    const { data } = matter(titleHostBytes);
    if (typeof data.title === "string" && data.title.trim()) {
      oldName = data.title;
    }
  }

  if (fromResolved === toResolved) {
    return {
      newPath: virtualPath,
      references: {
        linkCount: 0,
        pageCount: 0,
        undoToken: null,
        oldName,
        newName,
        changedPages: [],
      },
    };
  }

  // Guard against silent overwrite: fs.rename clobbers a regular file at the
  // destination on POSIX without error. fs.rename on directories has its own
  // ENOTEMPTY/EEXIST protection — surface the same friendly error for all
  // kinds so the user sees a useful message instead of lost data.
  const identityCollisions = kind === "page-file"
    ? [path.join(parentDir, slug), ...PAGE_EXTENSIONS.map((ext) => path.join(parentDir, `${slug}${ext}`))]
    : kind === "directory"
      ? PAGE_EXTENSIONS.map((ext) => path.join(parentDir, `${slug}${ext}`))
      : [];
  if (
    await firstExisting(
      [toResolved, ...identityCollisions].filter((candidate) => candidate !== fromResolved)
    )
  ) {
    throw new Error(
      `An item named "${targetBase}" already exists in ${
        parentVirtual ? `"${parentVirtual}"` : "the root"
      }. Pick a different name.`
    );
  }

  // Snapshot the page list *before* the move so wiki-link resolution reflects
  // the state the links were authored against. Typed-file renames don't touch
  // wiki-links, so skip the scan there.
  const preRenamePages =
    kind === "typed-file" ? [] : (await scanCabinet()).pages;

  await fs.rename(fromResolved, toResolved);

  // Update frontmatter title on whichever file backs this page's title.
  const titleHostAfter =
    kind === "directory"
      ? await findIndexPage(toResolved)
      : kind === "page-file"
        ? toResolved
        : null;
  if (titleHostAfter && (await fileExists(titleHostAfter))) {
    const raw = await readFileContent(titleHostAfter);
    const { data, content } = matter(raw);
    data.title = newName;
    data.modified = new Date().toISOString();
    const fm = Object.fromEntries(
      Object.entries(data).filter(([, v]) => v !== undefined)
    );
    const output = matter.stringify(content, fm);
    await writeFileContent(titleHostAfter, output);
  }

  // Match tree-builder's virtual-path shape: typed files keep their
  // extension, directories and standalone markdown pages do not.
  const newBaseVirtual = kind === "typed-file" ? `${slug}${preservedExt}` : slug;
  const newPath = parentVirtual ? `${parentVirtual}/${newBaseVirtual}` : newBaseVirtual;

  // Wiki-links can only point at markdown-backed pages, so skip the rewrite
  // scan for typed files entirely.
  const rewrite: RewriteResult =
    kind === "typed-file"
      ? { changed: [], linkCount: 0, pageCount: 0 }
      : await rewriteReferencesForRename({
          oldPagePath: virtualPath,
          newPagePath: newPath,
          oldResolvedDir: fromResolved,
          newResolvedDir: toResolved,
          oldSlug,
          newName,
          preRenamePages,
        });

  // Build the undo file set. The title-host bytes (when present) are always
  // included with the true pre-rename contents so Undo restores the original
  // title even when no links changed — and take precedence over any rewrite
  // entry for the same file.
  const undoFiles = new Map<string, string>();
  for (const c of rewrite.changed) {
    undoFiles.set(c.undoFsPath, c.before);
  }
  if (titleHostBytes !== null && titleHostBefore) {
    undoFiles.set(titleHostBefore, titleHostBytes);
  }

  const undoToken = recordRenameUndo({
    dirFrom: toResolved,
    dirTo: fromResolved,
    files: Array.from(undoFiles, ([fsPath, before]) => ({ fsPath, before })),
    createdAt: Date.now(),
    oldName,
    newName,
  });

  return {
    newPath,
    references: {
      linkCount: rewrite.linkCount,
      pageCount: rewrite.pageCount,
      undoToken,
      oldName,
      newName,
      changedPages: Array.from(
        new Set(rewrite.changed.map((c) => c.virtualPagePath))
      ),
    },
  };
}
