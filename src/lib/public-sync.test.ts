import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  publicSyncConfigFromEnv,
  syncPublicPages,
  validateBranch,
  validateRemoteUrl,
  type PublicSyncGit,
} from "./public-sync";

const REMOTE = "https://github.com/example/public-cabinet.git";

type Call = { method: string; args: string[] };

class FakeGit implements PublicSyncGit {
  calls: Call[] = [];
  stagedChanges = true;
  reportedRemote = REMOTE;

  async clone(remoteUrl: string, destination: string, branch: string) {
    this.calls.push({ method: "clone", args: [remoteUrl, destination, branch] });
    await fs.mkdir(path.join(destination, ".git"), { recursive: true });
  }
  async remoteUrl(repository: string) {
    this.calls.push({ method: "remoteUrl", args: [repository] });
    return this.reportedRemote;
  }
  async fastForward(repository: string, branch: string) {
    this.calls.push({ method: "fastForward", args: [repository, branch] });
  }
  async stage(repository: string, relativePath: string) {
    this.calls.push({ method: "stage", args: [repository, relativePath] });
  }
  async hasStagedChanges(repository: string, relativePath: string) {
    this.calls.push({ method: "hasStagedChanges", args: [repository, relativePath] });
    return this.stagedChanges;
  }
  async commit(repository: string, message: string, relativePath: string) {
    this.calls.push({ method: "commit", args: [repository, message, relativePath] });
  }
  async push(repository: string, branch: string) {
    this.calls.push({ method: "push", args: [repository, branch] });
  }
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-public-sync-"));
  const dataDir = path.join(root, "data");
  const stateDir = path.join(root, "state");
  const room = path.join(dataDir, "work");
  await fs.mkdir(path.join(room, "nested"), { recursive: true });
  await fs.writeFile(path.join(room, ".cabinet"), "name: Work\nkind: room\n", "utf8");
  return { root, dataDir, stateDir, room };
}

const config = { remoteUrl: REMOTE, branch: "main" };

test("public sync exports only explicitly public room markdown and uses mocked Git", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  await fs.writeFile(path.join(f.room, "public.md"), "---\npublic: true\ntitle: Public\n---\nhello\n");
  await fs.writeFile(path.join(f.room, "private.md"), "---\ntitle: Private\n---\nsecret\n");
  await fs.writeFile(path.join(f.room, "nested", "false.md"), "---\npublic: false\n---\nsecret\n");
  await fs.writeFile(path.join(f.dataDir, "loose.md"), "---\npublic: true\n---\nnot in a room\n");
  const outside = path.join(f.root, "outside.md");
  await fs.writeFile(outside, "---\npublic: true\n---\noutside\n");
  await fs.symlink(outside, path.join(f.room, "linked.md"));

  const git = new FakeGit();
  const result = await syncPublicPages({ ...f, config, git });
  const exportDir = path.join(f.stateDir, "public-sync", "repository", "content");

  assert.deepEqual(result, { exported: ["work/public.md"], pushed: true });
  assert.equal(await fs.readFile(path.join(exportDir, "work", "public.md"), "utf8"), "---\npublic: true\ntitle: Public\n---\nhello\n");
  await assert.rejects(fs.access(path.join(exportDir, "work", "private.md")));
  await assert.rejects(fs.access(path.join(exportDir, "loose.md")));
  assert.deepEqual(git.calls.map((call) => call.method), [
    "clone", "remoteUrl", "fastForward", "stage", "hasStagedChanges", "commit", "push",
  ]);
  assert.deepEqual(git.calls.find((call) => call.method === "stage")?.args.slice(-1), ["content"]);
  assert.deepEqual(git.calls.find((call) => call.method === "hasStagedChanges")?.args.slice(-1), ["content"]);
  assert.deepEqual(git.calls.find((call) => call.method === "commit")?.args.slice(-1), ["content"]);
  assert.deepEqual(git.calls.at(-1)?.args.slice(-1), ["main"]);
  assert.equal(git.calls.flatMap((call) => call.args).some((arg) => arg.includes("--force")), false);
});

test("public sync parses room manifests and skips home and invalid manifests", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const home = path.join(f.dataDir, "home-marker");
  const invalid = path.join(f.dataDir, "invalid-manifest");
  const scalar = path.join(f.dataDir, "scalar-manifest");
  const array = path.join(f.dataDir, "array-manifest");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(invalid, { recursive: true });
  await fs.mkdir(scalar, { recursive: true });
  await fs.mkdir(array, { recursive: true });
  await fs.writeFile(path.join(home, ".cabinet"), "kind: home\n");
  await fs.writeFile(path.join(invalid, ".cabinet"), "name: [unterminated\n");
  await fs.writeFile(path.join(scalar, ".cabinet"), "room\n");
  await fs.writeFile(path.join(array, ".cabinet"), "- room\n");
  for (const directory of [home, invalid, scalar, array]) {
    await fs.writeFile(path.join(directory, "public.md"), "---\npublic: true\n---\nnot a room\n");
  }
  await fs.writeFile(path.join(f.room, "public.md"), "---\npublic: true\n---\nroom\n");

  const result = await syncPublicPages({ ...f, config, git: new FakeGit() });

  assert.deepEqual(result.exported, ["work/public.md"]);
});

test("public sync replaces only its marked export and preserves repository files", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const repository = path.join(f.stateDir, "public-sync", "repository");
  const oldExport = path.join(repository, "content");
  await fs.mkdir(path.join(repository, ".git"), { recursive: true });
  await fs.mkdir(oldExport, { recursive: true });
  await fs.writeFile(path.join(oldExport, ".cabinet-public-export"), "owned\n");
  await fs.writeFile(path.join(oldExport, "stale.md"), "stale\n");
  await fs.writeFile(path.join(repository, "README.md"), "keep me\n");
  await fs.writeFile(path.join(f.room, "new.md"), "---\npublic: true\n---\nnew\n");

  await syncPublicPages({ ...f, config, git: new FakeGit() });

  assert.equal(await fs.readFile(path.join(repository, "README.md"), "utf8"), "keep me\n");
  await assert.rejects(fs.access(path.join(oldExport, "stale.md")));
  assert.match(await fs.readFile(path.join(oldExport, "work", "new.md"), "utf8"), /new/);
});

test("public sync refuses to clean an unowned destination", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const repository = path.join(f.stateDir, "public-sync", "repository");
  const destination = path.join(repository, "content");
  await fs.mkdir(path.join(repository, ".git"), { recursive: true });
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(destination, "do-not-delete.md"), "safe\n");

  await assert.rejects(
    syncPublicPages({ ...f, config, git: new FakeGit() }),
    /not owned by Cabinet/
  );
  assert.equal(await fs.readFile(path.join(destination, "do-not-delete.md"), "utf8"), "safe\n");
});

test("public sync requires and validates explicit remote configuration", () => {
  assert.throws(() => publicSyncConfigFromEnv({ NODE_ENV: "test" }), /must be set explicitly/);
  for (const unsafe of [
    "file:///tmp/repository",
    "/tmp/repository",
    "http://github.com/example/repository.git",
    "https://token@github.com/example/repository.git",
    "https://github.com/example/../repository.git",
  ]) {
    assert.throws(() => validateRemoteUrl(unsafe));
  }
  assert.equal(validateRemoteUrl(REMOTE), REMOTE);
  assert.equal(validateRemoteUrl("ssh://git@github.com/example/public-cabinet.git"), "ssh://git@github.com/example/public-cabinet.git");
});

test("public sync applies full Git branch name validation", () => {
  for (const unsafe of [
    "",
    "HEAD",
    "-topic",
    ".hidden",
    "feature/.hidden",
    "feature//topic",
    "feature/topic.lock",
    "feature/topic.",
    "feature..topic",
    "feature@{topic",
    "feature topic",
    "feature~topic",
    "feature^topic",
    "feature:topic",
    "feature?topic",
    "feature*topic",
    "feature[topic",
    "feature\\topic",
    "feature\u0000topic",
  ]) {
    assert.throws(() => validateBranch(unsafe), /branch name is unsafe/);
  }
  for (const safe of ["main", "feature/public-pages", "release/v1.0.0", "topic]suffix", "@", "Head"]) {
    assert.equal(validateBranch(safe), safe);
  }
});

test("public sync rejects a symbolic-link state directory before cloning", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const stateTarget = path.join(f.root, "state-target");
  await fs.mkdir(stateTarget);
  await fs.symlink(stateTarget, f.stateDir);
  const git = new FakeGit();

  await assert.rejects(syncPublicPages({ ...f, config, git }), /state directory.*symbolic link/);
  assert.equal(git.calls.length, 0);
});

test("public sync rejects a managed checkout whose origin changed", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const git = new FakeGit();
  git.reportedRemote = "https://github.com/attacker/repository.git";

  await assert.rejects(syncPublicPages({ ...f, config, git }), /does not match/);
  assert.equal(git.calls.some((call) => call.method === "fastForward"), false);
  assert.equal(git.calls.some((call) => call.method === "push"), false);
});

test("public sync does not commit or push when the export is unchanged", async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const git = new FakeGit();
  git.stagedChanges = false;

  const result = await syncPublicPages({ ...f, config, git });

  assert.equal(result.pushed, false);
  assert.equal(git.calls.some((call) => call.method === "commit"), false);
  assert.equal(git.calls.some((call) => call.method === "push"), false);
});
