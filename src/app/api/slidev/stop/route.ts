import { NextResponse } from "next/server";
import { getDaemonUrl, getOrCreateDaemonToken } from "@/lib/agents/daemon-auth";
import { resolveContentPath } from "@/lib/storage/path-utils";
import { fileExists } from "@/lib/storage/fs-operations";
import path from "path";

async function getAbsoluteMarkdownPath(virtualPath: string): Promise<string> {
  const resolved = resolveContentPath(virtualPath);
  
  const mdxPath = resolved.endsWith(".mdx") ? resolved : `${resolved}.mdx`;
  const mdPath = resolved.endsWith(".md") ? resolved : `${resolved}.md`;
  const indexPath = path.join(resolved, "index.md");

  if (await fileExists(mdxPath)) return mdxPath;
  if (await fileExists(mdPath)) return mdPath;
  if (await fileExists(indexPath)) return indexPath;
  if (await fileExists(resolved)) return resolved;
  
  return resolved;
}

export async function POST(req: Request) {
  try {
    const { filePath } = await req.json();
    if (!filePath) {
      return NextResponse.json({ error: "filePath is required" }, { status: 400 });
    }

    const absolutePath = await getAbsoluteMarkdownPath(filePath);

    const token = await getOrCreateDaemonToken();
    const daemonRes = await fetch(`${getDaemonUrl()}/slidev/stop`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({ filePath: absolutePath })
    });
    
    if (!daemonRes.ok) {
      throw new Error(`Daemon responded with code ${daemonRes.status}`);
    }
    const data = await daemonRes.json();
    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
