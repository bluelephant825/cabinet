import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseAction } from "./import";

// The re-import upsert decision: match by note id, newer modification wins.
test("chooseAction creates when the note is new", () => {
  assert.equal(chooseAction("2026-06-20T10:00:00.000Z", undefined), "create");
});

test("chooseAction updates when Notes is newer than the stored page", () => {
  assert.equal(
    chooseAction("2026-06-20T12:00:00.000Z", {
      virtualPath: "Apple Notes/x",
      modified: "2026-06-20T10:00:00.000Z",
    }),
    "update"
  );
});

test("chooseAction skips when the stored page is up to date", () => {
  assert.equal(
    chooseAction("2026-06-20T10:00:00.000Z", {
      virtualPath: "Apple Notes/x",
      modified: "2026-06-20T10:00:00.000Z",
    }),
    "skip"
  );
});

test("chooseAction updates a page that has no stored modified date", () => {
  assert.equal(
    chooseAction("2026-06-20T10:00:00.000Z", { virtualPath: "Apple Notes/x" }),
    "update"
  );
});
