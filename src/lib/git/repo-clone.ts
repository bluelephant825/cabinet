import fs from "fs/promises";
import path from "path";
import yaml from "js-yaml";
import { CABINET_LINK_META_FILE } from "@/lib/cabinets/files";
import { assertWritablePath } from "@/lib/knowledge-sources/store";
import { DATA_DIR, resolveContentPath, sanitizeFilename } from "@/lib/storage/path-utils";

export interface CloneRepoInput {
  remote?: string;
  branch?: string;
  name?: string;
  description?: string;
  destinationParent?: string;
  parentPath?: string;
}

export interface CloneRepoResult {
  path: string;
  localPath: string;
  branch: string;
}

export class CloneRepoError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "CloneRepoError";
  }
}

interface CloneRepoDependencies {
  dataDir?: string;
  resolveTreePath?: (virtualPath: string) => string;
  assertWritable?: (virtualPath: string) => Promise<void>;
  clone?: (remote: string, destination: string, branch?: string) => Promise<void>;
  currentBranch?: (destination: string) => Promise<string | undefined>;
  createSymlink?: (target: string, linkPath: string, type: "dir" | "junction") => Promise<void>;
  platform?: NodeJS.Platform;
}

interface DirectoryIdentity {
  dev: number;
  ino: number;
}

const SCP_REMOTE = /^git@([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?):([^\s\\?#]+)$/;
const FORBIDDEN_REF = /[~^:?*\[\\\x00-\x20\x7f]/;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string") throw new CloneRepoError(message);
  return value.trim();
}

function validateRepoPath(repoPath: string): void {
  const segments = repoPath.replace(/^\/+|\/+$/g, "").split("/");
  if (
    segments.length < 2 ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new CloneRepoError("Repository URL must include a valid repository path.");
  }
}

export function validateGitRemote(value: unknown): string {
  const remote = requireString(value, "Repository URL is required.");
  if (!remote) throw new CloneRepoError("Repository URL is required.");
  if (/[\x00-\x20\x7f]/.test(remote)) {
    throw new CloneRepoError("Repository URL contains invalid characters.");
  }

  const scpMatch = remote.match(SCP_REMOTE);
  if (scpMatch) {
    validateRepoPath(scpMatch[2].replace(/\.git$/i, ""));
    return remote;
  }

  let parsed: URL;
  try {
    parsed = new URL(remote);
  } catch {
    throw new CloneRepoError("Use an HTTPS or SSH Git repository URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") {
    throw new CloneRepoError("Only HTTPS and SSH Git repository URLs are allowed.");
  }
  if (!parsed.hostname || parsed.password || (parsed.protocol === "https:" && parsed.username)) {
    throw new CloneRepoError("Repository URLs cannot contain embedded credentials.");
  }
  if (parsed.search || parsed.hash) {
    throw new CloneRepoError("Repository URLs cannot contain a query or fragment.");
  }
  validateRepoPath(parsed.pathname.replace(/\.git\/?$/i, ""));
  return remote;
}

export function validateGitBranch(value?: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const branch = requireString(value, "Branch name is not valid.");
  const segments = branch.split("/");
  if (
    !branch ||
    branch.length > 255 ||
    branch === "@" ||
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.includes("@{") ||
    FORBIDDEN_REF.test(branch) ||
    segments.some((segment) => !segment || segment.startsWith(".") || segment.endsWith(".lock"))
  ) {
    throw new CloneRepoError("Branch name is not valid.");
  }
  return branch;
}

function inferredRepoName(remote: string): string {
  const pathname = remote.startsWith("git@")
    ? remote.slice(remote.indexOf(":") + 1)
    : new URL(remote).pathname;
  return pathname.replace(/[\\/]+$/, "").split(/[\\/]/).pop()?.replace(/\.git$/i, "") || "";
}

export function validateRepoName(value: unknown): { displayName: string; folderName: string } {
  const displayName = requireString(value, "A valid repository name is required.");
  if (
    !displayName ||
    displayName.length > 128 ||
    displayName === "." ||
    displayName === ".." ||
    !/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(displayName)
  ) {
    throw new CloneRepoError("A valid repository name is required.");
  }
  const folderName = sanitizeFilename(displayName);
  if (!folderName || WINDOWS_RESERVED_NAME.test(folderName)) {
    throw new CloneRepoError("A valid repository name is required.");
  }
  return { displayName, folderName };
}

export function validateParentPath(value?: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  const parent = requireString(value, "Parent path is not valid.");
  if (
    !parent ||
    path.isAbsolute(parent) ||
    parent.startsWith("./") ||
    parent.endsWith("/") ||
    parent.includes("\\") ||
    /[\x00-\x1f\x7f]/.test(parent) ||
    parent.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new CloneRepoError("Parent path is not valid.");
  }
  return parent;
}

function optionalDescription(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const description = requireString(value, "Description must be text.");
  if (description.length > 1000) throw new CloneRepoError("Description is too long.");
  return description || undefined;
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function realDirectoryWithin(directory: string, root: string): Promise<boolean> {
  const [realDirectory, realRoot] = await Promise.all([
    fs.realpath(directory).catch(() => null),
    fs.realpath(root).catch(() => path.resolve(root)),
  ]);
  return !!realDirectory && isWithin(realRoot, realDirectory);
}

async function removeOwnedDirectory(directory: string, identity: DirectoryIdentity): Promise<void> {
  const current = await fs.lstat(directory).catch(() => null);
  if (
    current?.isDirectory() &&
    !current.isSymbolicLink() &&
    current.dev === identity.dev &&
    current.ino === identity.ino
  ) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

export async function cloneAndLinkRepository(
  input: CloneRepoInput,
  dependencies: CloneRepoDependencies = {},
): Promise<CloneRepoResult> {
  if (!input || typeof input !== "object") throw new CloneRepoError("Invalid request body.");
  const remote = validateGitRemote(input.remote);
  const branch = validateGitBranch(input.branch);
  const requestedName = input.name === undefined || input.name === "" ? inferredRepoName(remote) : input.name;
  const { displayName, folderName } = validateRepoName(requestedName);
  const parentPath = validateParentPath(input.parentPath);
  const description = optionalDescription(input.description);
  const relativePath = parentPath ? `${parentPath}/${folderName}` : folderName;
  const destinationParentInput = requireString(
    input.destinationParent,
    "Choose an absolute folder to clone into.",
  );
  if (!destinationParentInput || !path.isAbsolute(destinationParentInput)) {
    throw new CloneRepoError("Choose an absolute folder to clone into.");
  }

  const dataDir = path.resolve(dependencies.dataDir ?? DATA_DIR);
  const resolveTreePath = dependencies.resolveTreePath ?? resolveContentPath;
  const assertWritable = dependencies.assertWritable ?? assertWritablePath;
  const targetDir = path.resolve(resolveTreePath(relativePath));
  if (!isWithin(dataDir, targetDir)) throw new CloneRepoError("Path traversal detected.");
  await assertWritable(relativePath);

  if (await fs.lstat(targetDir).catch(() => null)) {
    throw new CloneRepoError(`A folder named "${folderName}" already exists here.`, 409);
  }

  const targetParent = path.dirname(targetDir);
  const targetParentStat = await fs.lstat(targetParent).catch(() => null);
  let promotableParent: { markdown: string; index: string; directory: string } | undefined;
  if (targetParentStat) {
    if (!targetParentStat.isDirectory() || !(await realDirectoryWithin(targetParent, dataDir))) {
      throw new CloneRepoError("Parent folder is not a managed Cabinet folder.");
    }
  } else if (parentPath) {
    const markdown = `${targetParent}.md`;
    const markdownStat = await fs.lstat(markdown).catch(() => null);
    if (
      !markdownStat?.isFile() ||
      markdownStat.isSymbolicLink() ||
      !(await realDirectoryWithin(path.dirname(targetParent), dataDir))
    ) {
      throw new CloneRepoError("Parent folder does not exist.");
    }
    promotableParent = { markdown, index: path.join(targetParent, "index.md"), directory: targetParent };
  } else {
    throw new CloneRepoError("Parent folder does not exist.");
  }

  let destinationParent: string;
  try {
    destinationParent = await fs.realpath(destinationParentInput);
  } catch {
    throw new CloneRepoError("Clone destination must be an existing directory.");
  }
  const parentStat = await fs.stat(destinationParent).catch(() => null);
  if (!parentStat?.isDirectory()) {
    throw new CloneRepoError("Clone destination must be an existing directory.");
  }
  const realDataDir = await fs.realpath(dataDir).catch(() => dataDir);
  const destination = path.join(destinationParent, folderName);
  if (path.dirname(destination) !== destinationParent) throw new CloneRepoError("Clone path is not valid.");
  if (isWithin(realDataDir, destination)) {
    throw new CloneRepoError("Clone destination must be outside Cabinet's managed data folder.");
  }

  let ownedDestination: DirectoryIdentity | undefined;
  let symlinkCreated = false;
  let promotedParent = false;
  try {
    try {
      await fs.mkdir(destination);
      const created = await fs.lstat(destination);
      ownedDestination = { dev: created.dev, ino: created.ino };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new CloneRepoError(`The clone destination "${folderName}" already exists.`, 409);
      }
      throw error;
    }

    if (!dependencies.clone) throw new Error("Clone implementation is not configured.");
    await dependencies.clone(remote, destination, branch);
    const resolvedBranch = branch || (await dependencies.currentBranch?.(destination)) || "main";
    await fs.writeFile(
      path.join(destination, CABINET_LINK_META_FILE),
      yaml.dump(
        {
          title: displayName,
          tags: ["repo"],
          created: new Date().toISOString(),
          ...(description ? { description } : {}),
        },
        { lineWidth: -1, noRefs: true },
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(destination, ".repo.yaml"),
      yaml.dump(
        {
          name: displayName,
          local: destination,
          remote,
          source: "both",
          branch: resolvedBranch,
          ...(description ? { description } : {}),
        },
        { lineWidth: -1, noRefs: true },
      ),
      "utf8",
    );

    if (promotableParent) {
      await fs.mkdir(promotableParent.directory);
      promotedParent = true;
      await fs.rename(promotableParent.markdown, promotableParent.index);
    }

    const symlinkType = (dependencies.platform ?? process.platform) === "win32" ? "junction" : "dir";
    const createSymlink = dependencies.createSymlink ?? fs.symlink;
    await createSymlink(destination, targetDir, symlinkType);
    symlinkCreated = true;
    return { path: relativePath, localPath: destination, branch: resolvedBranch };
  } catch (error) {
    if (symlinkCreated) await fs.unlink(targetDir).catch(() => {});
    if (promotedParent && promotableParent) {
      await fs.rename(promotableParent.index, promotableParent.markdown).catch(() => {});
      await fs.rmdir(promotableParent.directory).catch(() => {});
    }
    if (ownedDestination) await removeOwnedDirectory(destination, ownedDestination);
    throw error;
  }
}
