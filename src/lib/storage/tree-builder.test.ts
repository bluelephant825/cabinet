import assert from "node:assert/strict";
import test from "node:test";
import { classifyFile } from "./tree-builder";

test("classifyFile recognizes Typst documents without changing other classifications", () => {
  assert.equal(classifyFile(".typ"), "typst");
  assert.equal(classifyFile(".tex"), "latex");
  assert.equal(classifyFile(".ts"), "code");
  assert.equal(classifyFile(".not-a-file-type"), null);
});
