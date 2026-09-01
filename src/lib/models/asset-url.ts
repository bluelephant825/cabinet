const MODEL_EXTENSIONS = /\.(?:glb|gltf)$/i;
const CONTROL_OR_BACKSLASH = /[\u0000-\u001f\u007f\\]/;

/**
 * Accept only same-origin Cabinet asset URLs for model rendering. Models can
 * reference additional buffers and textures, so arbitrary remote origins and
 * active URL schemes are intentionally refused at the registry boundary.
 */
export function sanitizeModelAssetUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate || CONTROL_OR_BACKSLASH.test(candidate)) return null;

  let parsed: URL;
  try {
    parsed = new URL(candidate, "http://cabinet.local");
  } catch {
    return null;
  }

  if (parsed.origin !== "http://cabinet.local") return null;
  if (!parsed.pathname.startsWith("/api/assets/")) return null;
  if (parsed.username || parsed.password || parsed.hash) return null;
  if (!MODEL_EXTENSIONS.test(parsed.pathname)) return null;

  return `${parsed.pathname}${parsed.search}`;
}

export function isModelFilePath(path: string): boolean {
  const cleanPath = path.split(/[?#]/, 1)[0];
  return MODEL_EXTENSIONS.test(cleanPath);
}
