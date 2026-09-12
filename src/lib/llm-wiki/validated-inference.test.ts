import test from "node:test";
import assert from "node:assert/strict";
import { validatedInference } from "./validated-inference";

test("invalid evidence is corrected with feedback and never accepted as a fallback", async () => {
  const prompts: string[] = [];
  const validate = (value: unknown) => { if (value !== "exact quote") throw new Error("Quote missing from source"); return value; };
  assert.equal(await validatedInference(async (feedback) => {
    prompts.push(feedback); return prompts.length === 1 ? "invented quote" : "exact quote";
  }, validate, new AbortController().signal), "exact quote");
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Quote missing from source/);
  assert.match(prompts[1], /Markdown markers, backslashes/);
  let calls = 0;
  await assert.rejects(validatedInference(async () => { calls++; return "invented quote"; }, validate, new AbortController().signal), /Quote missing/);
  assert.equal(calls, 3);
});

test("provider failure and cancellation do not start correction loops", async () => {
  let calls = 0;
  await assert.rejects(validatedInference(async () => { calls++; throw new Error("Provider unavailable"); }, () => true, new AbortController().signal), /Provider unavailable/);
  assert.equal(calls, 1);
  const controller = new AbortController();
  calls = 0;
  await assert.rejects(validatedInference(async () => { calls++; controller.abort(); return {}; }, () => { throw new Error("Invalid"); }, controller.signal), /abort/i);
  assert.equal(calls, 1);
});
