import fs from "fs/promises";
import path from "path";
import type { GoogleFrontmatter } from "@/types";

/**
 * Google Workspace shortcut files created by Drive for Desktop (.gdoc/.gsheet/…)
 * are small JSON pointers carrying the doc's web URL. Shared by the Drive
 * browser tree-builder, the normal tree-builder (so inline-mounted Drive
 * folders show native docs too), and readPage (so opening one renders the
 * Google viewer). See docs/CONNECT_KNOWLEDGE_PRD.md §7.
 */
export const GOOGLE_NATIVE_EXT: Record<string, GoogleFrontmatter["kind"]> = {
  ".gdoc": "docs",
  ".gsheet": "sheets",
  ".gslide": "slides",
  ".gslides": "slides",
  ".gform": "forms",
};

/** The Google kind for a filename's extension, or null if it isn't a shortcut. */
export function googleNativeKind(
  filename: string,
): GoogleFrontmatter["kind"] | null {
  return GOOGLE_NATIVE_EXT[path.extname(filename).toLowerCase()] ?? null;
}

/** Parse a Google shortcut file → { kind, url }, or null if not one / unparseable. */
export async function parseGoogleNative(
  filePath: string,
): Promise<{ kind: GoogleFrontmatter["kind"]; url: string } | null> {
  const kind = googleNativeKind(filePath);
  if (!kind) return null;
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data.url === "string") return { kind, url: data.url };
  } catch {
    // unparseable / not downloaded — skip
  }
  return null;
}
