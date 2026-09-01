import { NextRequest, NextResponse } from "next/server";
import { discoverPageLinks } from "@/lib/storage/page-links";

export async function GET(req: NextRequest) {
  const pagePath = req.nextUrl.searchParams.get("path");
  if (!pagePath) {
    return NextResponse.json(
      { error: "Missing path parameter" },
      { status: 400 }
    );
  }

  try {
    return NextResponse.json(await discoverPageLinks(pagePath));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message.includes("Path traversal")
      ? 400
      : message.includes("not found")
        ? 404
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
