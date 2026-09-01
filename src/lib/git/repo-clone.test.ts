import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import {
  cloneAndLinkRepository,
  CloneRepoError,
  validateGitBranch,
  validateGitRemote,
  validateParentPath,
  validateRepoName,
} from "./repo-clone";

async function withTempTree(
  run: (paths: { root: string; data: string; clones: string }) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-repo-clone-"));
  const data = path.join(root, "data");
  const clones = path.join(root, "clones");
  await fs.mkdir(data);
  await fs.mkdir(clones);
  try {
    await run({ root, data, clones });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function dependencies(data: string) {
  return {
    dataDir: data,
    resolveTreePath: (virtualPath: string) => path.join(data, virtualPath),
    assertWritable: async () => {},
    clone: async (_remote: string, destination: string) => {
      await fs.writeFile(path.join(destination, "README.md"), "# Example\n");
    },
    currentBranch: async () => "trunk",
  };
}

function expectCloneError(fn: () => unknown, message: RegExp): void {
  assert.throws(fn, (error: unknown) => error instanceof CloneRepoError && message.test(error.message));
}

test("cloneAndLinkRepository clones, writes linked-repo metadata, and creates a symlink", async () => {
  await withTempTree(async ({ data, clones }) => {
    const result = await cloneAndLinkRepository(
      {
        remote: "https://github.com/cabinetai/example.git",
        name: "Example Repo",
        description: "Example source",
        destinationParent: clones,
      },
      dependencies(data),
    );

    const realClones = await fs.realpath(clones);
    assert.deepEqual(result, {
      path: "example-repo",
      localPath: path.join(realClones, "example-repo"),
      branch: "trunk",
    });
    assert.equal((await fs.lstat(path.join(data, "example-repo"))).isSymbolicLink(), true);
    assert.equal(await fs.readFile(path.join(data, "example-repo", "README.md"), "utf8"), "# Example\n");

    const repoConfig = yaml.load(
      await fs.readFile(path.join(clones, "example-repo", ".repo.yaml"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(repoConfig.name, "Example Repo");
    assert.equal(repoConfig.local, path.join(realClones, "example-repo"));
    assert.equal(repoConfig.remote, "https://github.com/cabinetai/example.git");
    assert.equal(repoConfig.source, "both");
    assert.equal(repoConfig.branch, "trunk");

    const cabinetMeta = yaml.load(
      await fs.readFile(path.join(clones, "example-repo", ".cabinet-meta"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(cabinetMeta.title, "Example Repo");
    assert.deepEqual(cabinetMeta.tags, ["repo"]);
  });
});

test("cloneAndLinkRepository passes a validated branch and uses a Windows junction", async () => {
  await withTempTree(async ({ data, clones }) => {
    let cloneBranch: string | undefined;
    let link: { target: string; linkPath: string; type: string } | undefined;
    const result = await cloneAndLinkRepository(
      {
        remote: "ssh://git@github.com/cabinetai/example.git",
        branch: "release/v1.2",
        destinationParent: clones,
      },
      {
        ...dependencies(data),
        platform: "win32",
        clone: async (_remote, _destination, branch) => {
          cloneBranch = branch;
        },
        createSymlink: async (target, linkPath, type) => {
          link = { target, linkPath, type };
        },
      },
    );

    assert.equal(cloneBranch, "release/v1.2");
    assert.equal(result.branch, "release/v1.2");
    assert.deepEqual(link, {
      target: path.join(await fs.realpath(clones), "example"),
      linkPath: path.join(data, "example"),
      type: "junction",
    });
  });
});

test("cloneAndLinkRepository promotes a standalone parent page", async () => {
  await withTempTree(async ({ data, clones }) => {
    await fs.writeFile(path.join(data, "projects.md"), "# Projects\n");
    const result = await cloneAndLinkRepository(
      {
        remote: "git@github.com:cabinetai/example.git",
        destinationParent: clones,
        parentPath: "projects",
      },
      dependencies(data),
    );

    assert.equal(result.path, "projects/example");
    assert.equal(await fs.readFile(path.join(data, "projects", "index.md"), "utf8"), "# Projects\n");
    assert.equal((await fs.lstat(path.join(data, "projects", "example"))).isSymbolicLink(), true);
  });
});

test("clone failures remove only the directory created by the request", async () => {
  await withTempTree(async ({ data, clones }) => {
    await assert.rejects(
      cloneAndLinkRepository(
        {
          remote: "https://github.com/cabinetai/example.git",
          destinationParent: clones,
        },
        {
          ...dependencies(data),
          clone: async (_remote, destination) => {
            await fs.writeFile(path.join(destination, "partial"), "partial");
            throw new Error("mock clone failed");
          },
        },
      ),
      /mock clone failed/,
    );
    assert.equal(await fs.lstat(path.join(clones, "example")).catch(() => null), null);
  });
});

test("cleanup does not remove a destination path replaced during a failed clone", async () => {
  await withTempTree(async ({ data, clones }) => {
    await assert.rejects(
      cloneAndLinkRepository(
        {
          remote: "https://github.com/cabinetai/example.git",
          destinationParent: clones,
        },
        {
          ...dependencies(data),
          clone: async (_remote, destination) => {
            await fs.rename(destination, `${destination}-request-created`);
            await fs.mkdir(destination);
            await fs.writeFile(path.join(destination, "not-owned"), "keep");
            throw new Error("destination replaced");
          },
        },
      ),
      /destination replaced/,
    );
    assert.equal(await fs.readFile(path.join(clones, "example", "not-owned"), "utf8"), "keep");
  });
});

test("an ancestor of the managed data folder can be a clone parent", async () => {
  await withTempTree(async ({ root, data }) => {
    const result = await cloneAndLinkRepository(
      {
        remote: "https://github.com/cabinetai/example.git",
        destinationParent: root,
      },
      dependencies(data),
    );
    assert.equal(result.localPath, path.join(await fs.realpath(root), "example"));
  });
});

test("destinations inside the managed data folder are rejected", async () => {
  await withTempTree(async ({ data }) => {
    await assert.rejects(
      cloneAndLinkRepository(
        {
          remote: "https://github.com/cabinetai/example.git",
          destinationParent: data,
        },
        dependencies(data),
      ),
      /outside Cabinet's managed data folder/,
    );
  });
});

test("existing clone destinations are preserved", async () => {
  await withTempTree(async ({ data, clones }) => {
    const existing = path.join(clones, "example");
    await fs.mkdir(existing);
    await fs.writeFile(path.join(existing, "keep"), "keep");

    await assert.rejects(
      cloneAndLinkRepository(
        {
          remote: "https://github.com/cabinetai/example.git",
          destinationParent: clones,
        },
        dependencies(data),
      ),
      (error: unknown) => error instanceof CloneRepoError && error.status === 409,
    );
    assert.equal(await fs.readFile(path.join(existing, "keep"), "utf8"), "keep");
  });
});

test("read-only and symlinked parents are rejected before a destination is created", async () => {
  await withTempTree(async ({ root, data, clones }) => {
    let cloned = false;
    await assert.rejects(
      cloneAndLinkRepository(
        {
          remote: "https://github.com/cabinetai/example.git",
          destinationParent: clones,
          parentPath: "read-only",
        },
        {
          ...dependencies(data),
          assertWritable: async () => {
            throw new Error("read only");
          },
          clone: async () => {
            cloned = true;
          },
        },
      ),
      /read only/,
    );
    assert.equal(cloned, false);
    assert.equal(await fs.lstat(path.join(clones, "example")).catch(() => null), null);

    if (process.platform !== "win32") {
      const outside = path.join(root, "outside");
      await fs.mkdir(outside);
      await fs.symlink(outside, path.join(data, "linked"), "dir");
      await assert.rejects(
        cloneAndLinkRepository(
          {
            remote: "https://github.com/cabinetai/example.git",
            destinationParent: clones,
            parentPath: "linked",
          },
          dependencies(data),
        ),
        /managed Cabinet folder/,
      );
    }
  });
});

test("strict validators accept supported Git forms and reject unsafe input", () => {
  assert.equal(validateGitRemote("git@github.com:cabinetai/cabinet.git"), "git@github.com:cabinetai/cabinet.git");
  assert.equal(
    validateGitRemote("ssh://git@github.com/cabinetai/cabinet.git"),
    "ssh://git@github.com/cabinetai/cabinet.git",
  );
  for (const remote of [
    "http://github.com/cabinetai/cabinet.git",
    "file:///tmp/cabinet.git",
    "https://user:secret@github.com/cabinetai/cabinet.git",
    "https://github.com/cabinetai/cabinet.git?token=secret",
    "git@github.com:../cabinet.git",
    "--upload-pack=evil",
  ]) {
    expectCloneError(() => validateGitRemote(remote), /Repository|HTTPS|allowed|valid/);
  }

  assert.equal(validateGitBranch("feature/repo-clone"), "feature/repo-clone");
  for (const branch of ["-config", ".hidden", "feature..bad", "feature//bad", "main.lock", "bad name", "@{"]) {
    expectCloneError(() => validateGitBranch(branch), /Branch/);
  }

  assert.deepEqual(validateRepoName("Example Repo"), {
    displayName: "Example Repo",
    folderName: "example-repo",
  });
  for (const name of ["../repo", "repo.git", "CON", "bad/name", " bad?"]) {
    expectCloneError(() => validateRepoName(name), /repository name/);
  }

  assert.equal(validateParentPath("projects/source"), "projects/source");
  for (const parent of ["../projects", "./projects", "/projects", "projects/", "projects\\source"]) {
    expectCloneError(() => validateParentPath(parent), /Parent path/);
  }
});
