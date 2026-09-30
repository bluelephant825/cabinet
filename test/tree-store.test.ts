import assert from "node:assert/strict";
import test from "node:test";

import { useTreeStore } from "../src/stores/tree-store";

test("cabinet switch clears the shared sidebar tree cache and mounted nodes", () => {
  const removed: string[] = [];
  const previousWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      removeItem: (key: string) => removed.push(key),
    },
  };

  try {
    const node = { name: "old.md", path: "old.md", type: "file" as const };
    useTreeStore.setState({
      nodes: [node],
      rawNodes: [node],
      selectedPath: "old.md",
      driveNode: node,
      driveLoading: true,
      loading: false,
      recentlyChanged: new Set(["old.md"]),
    });

    useTreeStore.getState().resetForCabinetSwitch();

    assert.deepEqual(removed, ["kb-tree-cache"]);
    assert.deepEqual(useTreeStore.getState().nodes, []);
    assert.deepEqual(useTreeStore.getState().rawNodes, []);
    assert.equal(useTreeStore.getState().selectedPath, null);
    assert.equal(useTreeStore.getState().driveNode, null);
    assert.equal(useTreeStore.getState().driveLoading, false);
    assert.equal(useTreeStore.getState().loading, true);
    assert.equal(useTreeStore.getState().recentlyChanged.size, 0);
  } finally {
    (globalThis as { window?: unknown }).window = previousWindow;
    useTreeStore.setState({
      nodes: [],
      rawNodes: [],
      selectedPath: null,
      driveNode: null,
      driveLoading: false,
      loading: false,
      recentlyChanged: new Set(),
    });
  }
});
