import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_EDITOR_SETTINGS,
  normalizeEditorSettings,
} from "@/lib/ui/editor-settings";

test("normalizeEditorSettings returns defaults for invalid input", () => {
  assert.deepEqual(normalizeEditorSettings(null), DEFAULT_EDITOR_SETTINGS);
  assert.deepEqual(normalizeEditorSettings("invalid"), DEFAULT_EDITOR_SETTINGS);
});

test("normalizeEditorSettings preserves valid editor preferences", () => {
  assert.deepEqual(normalizeEditorSettings({
    theme: "vs-dark",
    fontFamily: "Fira Code",
    fontSize: 15,
    lineHeight: 23,
    fontWeight: "600",
    fontLigatures: false,
    minimap: false,
    tabSize: 4,
  }), {
    theme: "vs-dark",
    fontFamily: "Fira Code",
    fontSize: 15,
    lineHeight: 23,
    fontWeight: "600",
    fontLigatures: false,
    minimap: false,
    tabSize: 4,
  });
});

test("normalizeEditorSettings clamps numbers and replaces malformed values", () => {
  const normalized = normalizeEditorSettings({
    theme: "midnight",
    fontFamily: "  ",
    fontSize: 100,
    lineHeight: 4.7,
    fontWeight: null,
    fontLigatures: "yes",
    minimap: 1,
    tabSize: 0,
  });

  assert.equal(normalized.theme, DEFAULT_EDITOR_SETTINGS.theme);
  assert.equal(normalized.fontFamily, DEFAULT_EDITOR_SETTINGS.fontFamily);
  assert.equal(normalized.fontSize, 36);
  assert.equal(normalized.lineHeight, 10);
  assert.equal(normalized.fontWeight, DEFAULT_EDITOR_SETTINGS.fontWeight);
  assert.equal(normalized.fontLigatures, DEFAULT_EDITOR_SETTINGS.fontLigatures);
  assert.equal(normalized.minimap, DEFAULT_EDITOR_SETTINGS.minimap);
  assert.equal(normalized.tabSize, 1);
});
