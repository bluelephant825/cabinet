import test from "node:test";
import assert from "node:assert/strict";
import { classifyFileExtension } from "@/lib/storage/tree-builder";
import { isModelFilePath, sanitizeModelAssetUrl } from "./asset-url";

test("model asset URLs allow only same-origin Cabinet GLB and glTF assets", () => {
  assert.equal(sanitizeModelAssetUrl(" /api/assets/designs/chair.glb?version=2 "), "/api/assets/designs/chair.glb?version=2");
  assert.equal(sanitizeModelAssetUrl("/api/assets/designs/chair.GLTF"), "/api/assets/designs/chair.GLTF");

  for (const value of [
    "https://example.com/chair.glb",
    "//example.com/chair.glb",
    "javascript:alert(1)",
    "/api/assets/chair.obj",
    "/api/assets/chair.glb#details",
    "/uploads/chair.glb",
    "/api/assets/chair.glb\\ignored",
    42,
  ]) {
    assert.equal(sanitizeModelAssetUrl(value), null);
  }
});

test("model file helpers recognize GLB and glTF paths case-insensitively", () => {
  assert.equal(classifyFileExtension(".GLB"), "model");
  assert.equal(classifyFileExtension(".gltf"), "model");
  assert.equal(isModelFilePath("models/chair.GLB?version=2"), true);
  assert.equal(isModelFilePath("models/chair.obj"), false);
});
