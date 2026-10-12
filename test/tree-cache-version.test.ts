import test from "node:test";
import assert from "node:assert/strict";
import { getTreeMutationVersion, invalidateTreeCache } from "../src/lib/storage/tree-builder";

test("tree mutation invalidation changes the notification version even for nested files", () => {
  const before = getTreeMutationVersion();
  invalidateTreeCache();
  assert.equal(getTreeMutationVersion(), before + 1);
});

test("tree mutation version is shared globally between separately bundled routes", () => {
  const state = globalThis as unknown as { __cabinetTreeMutationVersion?: number };
  const before = getTreeMutationVersion();
  state.__cabinetTreeMutationVersion = before + 1;
  assert.equal(getTreeMutationVersion(), before + 1);
});
