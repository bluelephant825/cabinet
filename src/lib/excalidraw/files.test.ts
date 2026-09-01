import assert from "node:assert/strict";
import test from "node:test";
import {
  excalidrawFileTitle,
  isExcalidrawFilePath,
  isExcalidrawSvgPath,
} from "./files";
import { inferPageTypeFromPath } from "@/lib/ui/page-type-icons";

test("recognizes native and embedded-SVG Excalidraw files", () => {
  assert.equal(isExcalidrawFilePath("room/Sketch.excalidraw"), true);
  assert.equal(isExcalidrawFilePath("room/Sketch.EXCALIDRAW.SVG"), true);
  assert.equal(isExcalidrawFilePath("room/Sketch.svg"), false);
  assert.equal(isExcalidrawSvgPath("room/Sketch.excalidraw.svg"), true);
  assert.equal(isExcalidrawSvgPath("room/Sketch.excalidraw"), false);
});

test("derives display titles without losing dotted names", () => {
  assert.equal(excalidrawFileTitle("room/System.v2.excalidraw.svg"), "System.v2");
  assert.equal(excalidrawFileTitle("room/System.v2.excalidraw"), "System.v2");
});

test("classifies embedded Excalidraw SVGs before generic images", () => {
  assert.equal(inferPageTypeFromPath("room/Sketch.excalidraw.svg"), "excalidraw");
  assert.equal(inferPageTypeFromPath("room/Sketch.svg"), "image");
});
