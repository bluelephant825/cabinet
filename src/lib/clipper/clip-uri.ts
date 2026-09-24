/**
 * Parses `cabinet://new?...` URIs opened by the cabinet-clipper browser
 * extension into a clip request. Pure — no I/O.
 */

export class InvalidClipUriError extends Error {}

export type ClipRequest = {
  file: string;
  content?: string;
  clipboard: boolean;
  silent: boolean;
  vault?: string;
};

/**
 * Normalize a virtual page path: trim, strip leading/trailing slashes,
 * collapse repeated slashes, drop a trailing .md/.mdx extension. Throws
 * InvalidClipUriError on an empty result or any `.`/`..` segment.
 */
export function normalizeClipPath(raw: string): string {
  const normalized = raw
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\.(md|mdx)$/i, "")
    .replace(/\/+$/, "");
  if (!normalized) throw new InvalidClipUriError("Missing page path");
  for (const segment of normalized.split("/")) {
    if (segment === "." || segment === "..") {
      throw new InvalidClipUriError("Invalid page path");
    }
  }
  return normalized;
}

export function parseClipUri(uri: string): ClipRequest {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new InvalidClipUriError("Not a valid URI");
  }
  if (url.protocol !== "cabinet:") {
    throw new InvalidClipUriError("Not a cabinet:// URI");
  }
  if (url.hostname !== "new") {
    throw new InvalidClipUriError("Unsupported cabinet:// action");
  }
  const params = url.searchParams;
  const fileParam = params.get("file");
  const raw =
    fileParam ??
    `${params.get("path") ?? ""}/${params.get("name") ?? ""}`;
  const file = normalizeClipPath(raw);
  const content = params.get("content");
  return {
    file,
    content: content ? content : undefined,
    clipboard: params.get("clipboard") === "true",
    silent: params.get("silent") === "true",
    vault: params.get("vault") ?? undefined,
  };
}
