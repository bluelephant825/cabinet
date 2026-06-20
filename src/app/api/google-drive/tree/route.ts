import { NextRequest, NextResponse } from "next/server";
import { buildGoogleDriveTree } from "@/lib/google-drive/tree-builder";
import { listDriveMounts } from "@/lib/knowledge-sources/store";

export async function GET(request: NextRequest) {
  try {
    const cabinet = request.nextUrl.searchParams.get("cabinet") ?? "";
    const mounts = await listDriveMounts(cabinet);

    if (mounts.length === 0) {
      return NextResponse.json({ sections: [] });
    }

    const sections = await buildGoogleDriveTree(mounts);
    return NextResponse.json({ sections });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
