import { NextRequest, NextResponse } from "next/server";
import childProcess from "child_process";
import path from "path";
import { getServerDataLocations } from "@/lib/data-locations/server-registry";

export const dynamic = "force-dynamic";

function openPath(targetPath: string): void {
  const options = { stdio: "ignore" as const, detached: true };
  const child =
    process.platform === "darwin"
      ? childProcess.spawn("open", [targetPath], options)
      : process.platform === "win32"
        ? childProcess.spawn("explorer.exe", [targetPath], options)
        : childProcess.spawn("xdg-open", [targetPath], options);
  child.unref();
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const target = typeof body?.path === "string" ? body.path : "";
    if (!target) {
      return NextResponse.json({ error: "Missing path" }, { status: 400 });
    }
    const resolved = path.resolve(/* turbopackIgnore: true */ target);
    const allowed = getServerDataLocations()
      .filter((row) => row.scope === "fs")
      .map((row) => path.resolve(/* turbopackIgnore: true */ row.pathOrKey));
    if (!allowed.includes(resolved)) {
      return NextResponse.json(
        { error: "Path is not in the data-locations registry" },
        { status: 403 }
      );
    }
    openPath(resolved);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
