import fs from "fs";
import os from "os";
import path from "path";
import { decodeDrivePath, encodeDrivePath } from "@/lib/google-drive/paths";
import { DATA_DIR, resolveContentPath, virtualPathFromFs } from "@/lib/storage/path-utils";

export const JUPYTER_REQUEST_LIMIT = 1024 * 1024;
export const JUPYTER_RESPONSE_LIMIT = 10 * 1024 * 1024;
export const JUPYTER_PROXY_TIMEOUT_MS = 10_000;
export const JUPYTER_WS_CONNECT_TIMEOUT_MS = 5_000;
export const JUPYTER_WS_MESSAGE_LIMIT = 10 * 1024 * 1024;

export interface JupyterServerInfo {
  url: string;
  token: string;
  port: number;
  rootDir?: string;
}

interface DiscoveryOptions {
  runtimeDir?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function getJupyterRuntimeDir(): string {
  const home = os.homedir();
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "jupyter", "runtime");
  }
  if (process.platform === "darwin") return path.join(home, "Library", "Jupyter", "runtime");
  return path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), "jupyter", "runtime");
}

function normalizeServerInfo(value: unknown): JupyterServerInfo | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (typeof data.url !== "string" || typeof data.token !== "string") return null;
  try {
    const url = new URL(data.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) return null;
    if (url.username || url.password) return null;
    url.search = "";
    url.hash = "";
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    const port = Number(data.port || url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return {
      url: url.toString(),
      token: data.token,
      port,
      rootDir: typeof data.root_dir === "string" && path.isAbsolute(data.root_dir)
        ? path.normalize(data.root_dir)
        : undefined,
    };
  } catch {
    return null;
  }
}

export async function findActiveJupyterServer(options: DiscoveryOptions = {}): Promise<JupyterServerInfo | null> {
  const runtimeDir = options.runtimeDir ?? getJupyterRuntimeDir();
  const fetchImpl = options.fetchImpl ?? fetch;
  let files: { fullPath: string; mtime: number }[];
  try {
    files = fs.readdirSync(runtimeDir)
      .filter((name) => /^(?:jp|nb)server-[^/]+\.json$/.test(name))
      .map((name) => {
        const fullPath = path.join(runtimeDir, name);
        return { fullPath, mtime: fs.statSync(fullPath).mtimeMs };
      })
      .sort((left, right) => right.mtime - left.mtime);
  } catch {
    return null;
  }

  for (const file of files) {
    try {
      const info = normalizeServerInfo(JSON.parse(fs.readFileSync(file.fullPath, "utf8")));
      if (!info) continue;
      const checkUrl = new URL("api/status", info.url);
      checkUrl.searchParams.set("token", info.token);
      const response = await fetchImpl(checkUrl, {
        cache: "no-store",
        signal: AbortSignal.timeout(options.timeoutMs ?? 1_000),
      });
      if (response.ok) return info;
    } catch {
      // Runtime files commonly outlive their process. Try the next newest file.
    }
  }
  return null;
}

export function isAllowedJupyterProxyRequest(method: string, subpath: string): boolean {
  if (method === "GET" && subpath === "api/sessions") return true;
  if (method === "POST" && subpath === "api/sessions") return true;
  if (method === "DELETE" && /^api\/sessions\/[A-Za-z0-9_-]{1,128}$/.test(subpath)) return true;
  return method === "POST" && /^api\/kernels\/[A-Za-z0-9_-]{1,128}\/(?:interrupt|restart)$/.test(subpath);
}

function isWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function toJupyterPath(virtualPath: string, rootDir: string, authorizedMounts: string[] = []): string {
  if (!virtualPath || virtualPath.includes("\0")) throw new Error("Invalid notebook path");
  const drivePath = decodeDrivePath(virtualPath);
  const absolute = drivePath === null ? resolveContentPath(virtualPath) : path.normalize(drivePath);
  if (drivePath !== null && !path.isAbsolute(absolute)) throw new Error("Invalid mounted notebook path");
  if (drivePath !== null && !authorizedMounts.some((mount) => isWithin(absolute, mount))) {
    throw new Error("Notebook path is not within an authorized mount");
  }
  const relative = path.relative(path.resolve(rootDir), absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Notebook is outside the Jupyter root");
  }
  return relative.split(path.sep).join("/");
}

export function fromJupyterPath(jupyterPath: string, rootDir: string, authorizedMounts: string[] = []): string {
  if (!jupyterPath || jupyterPath.includes("\0") || path.isAbsolute(jupyterPath)) {
    throw new Error("Invalid Jupyter session path");
  }
  const absolute = path.resolve(rootDir, jupyterPath);
  if (!isWithin(absolute, rootDir)) throw new Error("Jupyter session escaped its root");
  if (isWithin(absolute, DATA_DIR)) return virtualPathFromFs(absolute);
  if (authorizedMounts.some((mount) => isWithin(absolute, mount))) return encodeDrivePath(absolute);
  throw new Error("Jupyter session path is outside authorized content");
}
