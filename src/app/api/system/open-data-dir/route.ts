import childProcess from "child_process";
import { existsSync } from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { DATA_DIR } from "@/lib/storage/path-utils";

export const dynamic = "force-dynamic";

// Tree node paths for Markdown pages drop the `.md` extension (see
// tree-builder: `path: vPath.replace(/\.md$/, "")`), so the virtual path
// often has no matching file on disk. Map it back to the real entry —
// `<page>.md`, or `<page>/index.md` for container pages — so `open -R`
// has something to reveal. Falls back to the original path (and finally
// its parent) so directories and real-extension files keep working.
function resolveOnDisk(resolved: string): string {
  // Prefer the virtual Markdown targets first: a page can have a same-named
  // sibling directory (sub-pages), so checking `existsSync(resolved)` up front
  // would reveal that folder instead of the page's own `<page>.md`. `.md` and
  // `<page>/index.md` (container pages) take priority; only then fall back to
  // the bare path (real directories / real-extension files) and its parent.
  const withMd = `${resolved}.md`;
  if (existsSync(/* turbopackIgnore: true */ withMd)) return withMd;
  const indexMd = path.join(/* turbopackIgnore: true */ resolved, "index.md");
  if (existsSync(/* turbopackIgnore: true */ indexMd)) return indexMd;
  if (existsSync(/* turbopackIgnore: true */ resolved)) return resolved;
  const parent = path.dirname(resolved);
  if (existsSync(/* turbopackIgnore: true */ parent)) return parent;
  return resolved;
}

function spawnOpenCommand(targetPath: string, reveal: boolean) {
  const options = { stdio: "ignore" as const };
  if (process.platform === "darwin") {
    return childProcess.spawn("open", reveal ? ["-R", targetPath] : [targetPath], options);
  }
  if (process.platform === "win32") {
    return childProcess.spawn(
      "explorer.exe",
      reveal ? ["/select,", targetPath] : [targetPath],
      options
    );
  }
  return childProcess.spawn("xdg-open", [targetPath], options);
}

export async function POST(request: Request) {
  try {
    let targetPath = DATA_DIR;

    // Optional subpath to open a specific item
    const body = await request.json().catch(() => null);
    if (body?.subpath) {
      const resolved = path.resolve(/* turbopackIgnore: true */ DATA_DIR, body.subpath);
      if (resolved !== DATA_DIR && !resolved.startsWith(DATA_DIR + path.sep)) {
        return NextResponse.json({ error: "Invalid path" }, { status: 400 });
      }
      // resolveOnDisk can fall back to a parent directory, so re-check that the
      // final on-disk target is still inside DATA_DIR before opening it.
      const onDisk = resolveOnDisk(resolved);
      if (onDisk !== DATA_DIR && !onDisk.startsWith(DATA_DIR + path.sep)) {
        return NextResponse.json({ error: "Invalid path" }, { status: 400 });
      }
      targetPath = onDisk;
    }

    // Reveal in Finder when opening a specific subpath
    await new Promise<void>((resolve, reject) => {
      const proc = spawnOpenCommand(targetPath, !!body?.subpath);

      proc.on("error", (error) => {
        reject(error);
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`Command exited with code ${code}`));
      });
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
