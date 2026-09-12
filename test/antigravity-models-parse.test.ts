import test from "node:test";
import assert from "node:assert/strict";
import { parseAntigravityModels } from "../src/lib/agents/providers/antigravity-cli";

// Real shape of `agy models` stdout on 1.2.2: a "Fetching" status line,
// then tab-separated `slug\tDisplay Name` rows.
const REAL_OUTPUT = [
  "Fetching available models...",
  "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
  "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
  "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
].join("\n");

test("parses slug/display-name rows, skipping the Fetching header", () => {
  const models = parseAntigravityModels(REAL_OUTPUT);
  assert.deepEqual(models, [
    { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
    { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
  ]);
});

test("trims padded lines and drops rows without a tab", () => {
  const noisy = [
    "",
    "Fetching available models...",
    "   gemini-3.1-pro-high\tGemini 3.1 Pro (High)   ",
    "done",
  ].join("\n");
  const models = parseAntigravityModels(noisy);
  assert.deepEqual(models, [
    { id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)" },
  ]);
});

test("empty / whitespace / nullish output falls back to the static list", () => {
  for (const input of ["", "   \n  \n", null, undefined]) {
    const models = parseAntigravityModels(input);
    assert.ok(models.length > 0, "fallback must not be empty");
    assert.ok(models.some((m) => m.id === "gemini-3.8-flash-medium"));
  }
});

test("output that is only noise falls back, never blank", () => {
  const models = parseAntigravityModels("loading...\nno models\n");
  assert.ok(models.some((m) => m.id === "claude-opus-4-6-thinking"));
});
