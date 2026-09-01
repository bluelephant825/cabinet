import test from "node:test";
import assert from "node:assert/strict";
import { assetUrlFor } from "@/lib/cabinets/asset-url";
import {
  clampMediaTime,
  formatMediaTime,
  mediaErrorMessage,
  nextPlaybackRate,
} from "./media-player-utils";

test("assetUrlFor encodes each media path segment without losing separators", () => {
  assert.equal(
    assetUrlFor("Demo room/Clips/Résumé #1.mp4"),
    "/api/assets/Demo%20room/Clips/R%C3%A9sum%C3%A9%20%231.mp4"
  );
  assert.equal(assetUrlFor("100%/sample audio.ogg"), "/api/assets/100%25/sample%20audio.ogg");
});

test("media time helpers format and clamp seek positions", () => {
  assert.equal(formatMediaTime(65.9), "1:05");
  assert.equal(formatMediaTime(3661), "1:01:01");
  assert.equal(formatMediaTime(Number.NaN), "0:00");
  assert.equal(clampMediaTime(-10, 120), 0);
  assert.equal(clampMediaTime(150, 120), 120);
  assert.equal(clampMediaTime(20, Number.POSITIVE_INFINITY), 20);
});

test("playback rates advance and wrap predictably", () => {
  assert.equal(nextPlaybackRate(1), 1.25);
  assert.equal(nextPlaybackRate(2), 0.5);
  assert.equal(nextPlaybackRate(1.4), 1.5);
});

test("media errors provide useful browser failure messages", () => {
  assert.match(mediaErrorMessage(2), /network error/i);
  assert.match(mediaErrorMessage(3), /decoded/i);
  assert.match(mediaErrorMessage(4), /not supported/i);
  assert.match(mediaErrorMessage(), /could not be played/i);
});
