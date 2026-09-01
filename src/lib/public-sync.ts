import fs from "fs/promises";
import path from "path";
import matter from "gray-matter";
import yaml from "js-yaml";
import simpleGit from "simple-git";
import { CABINET_INTERNAL_DIR, DATA_DIR } from "@/lib/storage/path-utils";

const OWNER_MARKER = ".cabinet-public-export";
const DEFAULT_BRANCH = "main";

export interface PublicSyncConfig {
  remoteUrl: string;
  branch: string;
}

export interface PublicSyncGit {
  clone(remoteUrl: string, destination: string, branch: string): Promise<void>;
  remoteUrl(repository: string): Promise<string>;
  fastForward(repository: string, branch: string): Promise<void>;
  stage(repository: string, relativePath: string): Promise<void>;
  hasStagedChanges(repository: string, relativePath: string): Promise<boolean>;
  commit(repository: string, message: string, relativePath: string): Promise<void>;
  push(repository: string, branch: string): Promise<void>;
}

export interface PublicSyncOptions {
  config?: PublicSyncConfig;
  dataDir?: string;
  stateDir?: string;
  git?: PublicSyncGit;
}

export interface PublicSyncResult {
  exported: string[];
  pushed: boolean;
}

function invalid(message: string): never {
  throw new Error(`Invalid public sync configuration: ${message}`);
}

export function validateRemoteUrl(value: string): string {
  const remote = value.trim();
  if (!remote || /[\0\r\n]/.test(remote)) invalid("remote URL is required");

  let parsed: URL;
  try {
    parsed = new URL(remote);
  } catch {
    invalid("remote must be an absolute HTTPS or SSH URL");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") {
    invalid("remote protocol must be HTTPS or SSH");
  }
  if (!parsed.hostname || parsed.password || parsed.search || parsed.hash) {
    invalid("remote URL contains credentials or unsupported components");
  }
  if (parsed.protocol === "https:" && parsed.username) {
    invalid("HTTPS remote must not contain credentials");
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(parsed.pathname);
  } catch {
    invalid("remote path has invalid escaping");
  }
  const segments = decodedPath.split("/").filter(Boolean);
  if (
    segments.length < 2 ||
    segments.some((segment) => segment === "." || segment === ".." || /[\\\0\r\n]/.test(segment))
  ) {
    invalid("remote path must identify an owner and repository");
  }

  return remote;
}

export function validateBranch(value: string): string {
  const branch = value.trim();
  const components = branch.split("/");
  if (
    !branch ||
    branch === "HEAD" ||
    branch.startsWith("-") ||
    branch.endsWith(".") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    /[\x00-\x20\x7f~^:?*\[\\]/.test(branch) ||
    components.some(
      (component) =>
        !component || component.startsWith(".") || component.endsWith(".lock")
    )
  ) {
    invalid("branch name is unsafe");
  }
  return branch;
}

export function publicSyncConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): PublicSyncConfig {
  const remoteUrl = env.CABINET_PUBLIC_SYNC_REMOTE;
  if (!remoteUrl) invalid("CABINET_PUBLIC_SYNC_REMOTE must be set explicitly");
  return {
    remoteUrl: validateRemoteUrl(remoteUrl),
    branch: validateBranch(env.CABINET_PUBLIC_SYNC_BRANCH ?? DEFAULT_BRANCH),
  };
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function assertSafeDirectoryBoundary(stateDir: string, managedRoot: string): Promise<void> {
  if (!path.isAbsolute(stateDir) || !isInside(stateDir, managedRoot)) {
    throw new Error("Public sync destination must be inside the managed state directory");
  }

  const stateStat = await fs.lstat(stateDir).catch(() => null);
  if (!stateStat?.isDirectory() || stateStat.isSymbolicLink()) {
    throw new Error("Public sync state directory must not be a symbolic link");
  }

  const relative = path.relative(stateDir, managedRoot);
  let current = path.resolve(stateDir);
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch(() => null);
    if (stat?.isSymbolicLink()) {
      throw new Error("Public sync destination must not traverse symbolic links");
    }
  }
}

async function collectPublicMarkdown(dataDir: string): Promise<Array<{ relativePath: string; body: string }>> {
  const exports: Array<{ relativePath: string; body: string }> = [];
  const topLevel = await fs.readdir(dataDir, { withFileTypes: true }).catch(() => []);

  for (const room of topLevel.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!room.isDirectory() || room.name.startsWith(".")) continue;
    const roomDir = path.join(dataDir, room.name);
    const manifestPath = path.join(roomDir, ".cabinet");
    const manifestStat = await fs.lstat(manifestPath).catch(() => null);
    if (!manifestStat?.isFile()) continue;

    let manifest: unknown;
    try {
      manifest = yaml.load(await fs.readFile(manifestPath, "utf8"));
    } catch {
      continue;
    }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) continue;
    if ((manifest as Record<string, unknown>).kind === "home") continue;

    async function walk(directory: string): Promise<void> {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith(".")) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          await walk(absolute);
          continue;
        }
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
        const body = await fs.readFile(absolute, "utf8");
        const parsed = matter(body);
        if (parsed.data.public !== true) continue;
        const relativePath = path.relative(dataDir, absolute);
        if (!isInside(dataDir, absolute)) {
          throw new Error("Public source escaped the data directory");
        }
        exports.push({ relativePath, body });
      }
    }

    await walk(roomDir);
  }

  return exports;
}

async function hasOwnerMarker(directory: string): Promise<boolean> {
  const marker = await fs.lstat(path.join(directory, OWNER_MARKER)).catch(() => null);
  return marker?.isFile() === true;
}

async function replaceOwnedExport(
  managedRoot: string,
  destination: string,
  pages: Array<{ relativePath: string; body: string }>
): Promise<void> {
  const staging = path.join(managedRoot, `export-staging-${process.pid}-${Date.now()}`);
  const backup = path.join(managedRoot, `export-backup-${process.pid}-${Date.now()}`);
  await fs.mkdir(staging, { recursive: false });

  try {
    await fs.writeFile(
      path.join(staging, OWNER_MARKER),
      "Managed by Cabinet public sync. Only this marked directory may be replaced.\n",
      "utf8"
    );
    for (const page of pages) {
      const target = path.resolve(staging, page.relativePath);
      if (!isInside(staging, target)) throw new Error("Unsafe public export path");
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, page.body, { encoding: "utf8", flag: "wx" });
    }

    const existing = await fs.lstat(destination).catch(() => null);
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink() || !(await hasOwnerMarker(destination))) {
        throw new Error("Refusing to replace an export destination not owned by Cabinet");
      }
      await fs.rename(destination, backup);
    }

    try {
      await fs.rename(staging, destination);
    } catch (error) {
      if (existing) await fs.rename(backup, destination).catch(() => undefined);
      throw error;
    }

    if (existing && (await hasOwnerMarker(backup))) {
      await fs.rm(backup, { recursive: true, force: false });
    }
  } catch (error) {
    if (await hasOwnerMarker(staging)) {
      await fs.rm(staging, { recursive: true, force: false }).catch(() => undefined);
    }
    throw error;
  }
}

const defaultGit: PublicSyncGit = {
  async clone(remoteUrl, destination, branch) {
    await simpleGit().clone(remoteUrl, destination, ["--branch", branch, "--single-branch"]);
  },
  async remoteUrl(repository) {
    return (await simpleGit(repository).raw(["remote", "get-url", "origin"])).trim();
  },
  async fastForward(repository, branch) {
    const git = simpleGit(repository);
    await git.fetch("origin", branch);
    await git.merge(["--ff-only", `origin/${branch}`]);
  },
  async stage(repository, relativePath) {
    await simpleGit(repository).add(["--all", "--", relativePath]);
  },
  async hasStagedChanges(repository, relativePath) {
    const staged = await simpleGit(repository).raw([
      "diff",
      "--cached",
      "--name-only",
      "--",
      relativePath,
    ]);
    return staged.trim().length > 0;
  },
  async commit(repository, message, relativePath) {
    await simpleGit(repository).raw(["commit", "-m", message, "--", relativePath]);
  },
  async push(repository, branch) {
    await simpleGit(repository).push("origin", branch);
  },
};

export async function syncPublicPages(options: PublicSyncOptions = {}): Promise<PublicSyncResult> {
  const config = options.config ?? publicSyncConfigFromEnv();
  const remoteUrl = validateRemoteUrl(config.remoteUrl);
  const branch = validateBranch(config.branch);
  const dataDir = path.resolve(options.dataDir ?? DATA_DIR);
  const stateDir = path.resolve(options.stateDir ?? CABINET_INTERNAL_DIR);
  const managedRoot = path.join(stateDir, "public-sync");
  const repository = path.join(managedRoot, "repository");
  const destination = path.join(repository, "content");
  const git = options.git ?? defaultGit;

  await fs.mkdir(stateDir, { recursive: true });
  await assertSafeDirectoryBoundary(stateDir, managedRoot);
  await fs.mkdir(managedRoot, { recursive: true });

  const repositoryStat = await fs.lstat(repository).catch(() => null);
  if (!repositoryStat) {
    await git.clone(remoteUrl, repository, branch);
  } else if (!repositoryStat.isDirectory() || repositoryStat.isSymbolicLink()) {
    throw new Error("Public sync repository is not a safe directory");
  }

  const gitMetadata = await fs.lstat(path.join(repository, ".git")).catch(() => null);
  if (!gitMetadata?.isDirectory() || gitMetadata.isSymbolicLink()) {
    throw new Error("Public sync destination is not a managed Git repository");
  }

  const configuredRemote = validateRemoteUrl(await git.remoteUrl(repository));
  if (configuredRemote !== remoteUrl) {
    throw new Error("Public sync repository remote does not match configured remote");
  }

  await git.fastForward(repository, branch);
  const pages = await collectPublicMarkdown(dataDir);
  await replaceOwnedExport(managedRoot, destination, pages);
  await git.stage(repository, "content");

  if (!(await git.hasStagedChanges(repository, "content"))) {
    return { exported: pages.map((page) => page.relativePath), pushed: false };
  }

  await git.commit(repository, "sync public Cabinet pages", "content");
  await git.push(repository, branch);
  return { exported: pages.map((page) => page.relativePath), pushed: true };
}
