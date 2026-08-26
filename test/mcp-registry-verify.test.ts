import test from "node:test";
import assert from "node:assert/strict";
import { verifyTier } from "@/lib/agents/mcp-registry-verify";

test("vendor tier stands on its own — no registry corroboration needed", () => {
  assert.equal(verifyTier("vendor", undefined, {}), "vendor");
});

test("vendor tier is not downgraded even when the registry is reachable", () => {
  assert.equal(verifyTier("vendor", undefined, { notion: true }), "vendor");
});

test("cabinet tier still stands on its own", () => {
  assert.equal(verifyTier("cabinet", undefined, {}), "cabinet");
});

test("official is granted only when the registry corroborates it", () => {
  assert.equal(verifyTier("official", "notion", { notion: true }), "official");
});

test("uncorroborated official degrades to registry, never lies", () => {
  assert.equal(verifyTier("official", "notion", { notion: false }), "registry");
});

test("official without a registryId falls through to community", () => {
  assert.equal(verifyTier("official", undefined, {}), "community");
});
