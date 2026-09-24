import test from "node:test";
import assert from "node:assert/strict";
import { InvalidClipUriError, parseClipUri } from "./clip-uri";

test("file param wins over path+name", () => {
  const clip = parseClipUri(
    "cabinet://new?vault=Cab/Room&path=folder/&name=Name&file=Room/folder/Name",
  );
  assert.equal(clip.file, "Room/folder/Name");
  assert.equal(clip.vault, "Cab/Room");
});

test("path+name combine into file when file param is absent", () => {
  const clip = parseClipUri("cabinet://new?path=Clips/&name=Hello");
  assert.equal(clip.file, "Clips/Hello");
});

test("clipboard and silent flags parse only literal 'true'", () => {
  const clip = parseClipUri(
    "cabinet://new?file=A&clipboard=true&silent=true",
  );
  assert.equal(clip.clipboard, true);
  assert.equal(clip.silent, true);
  const off = parseClipUri("cabinet://new?file=A&clipboard=1&silent=yes");
  assert.equal(off.clipboard, false);
  assert.equal(off.silent, false);
});

test("content param is decoded; empty content is treated as absent", () => {
  const clip = parseClipUri(
    `cabinet://new?file=A&content=${encodeURIComponent("---\ntitle: Hi\n---\n# Hi")}`,
  );
  assert.equal(clip.content, "---\ntitle: Hi\n---\n# Hi");
  const empty = parseClipUri("cabinet://new?file=A&content=");
  assert.equal(empty.content, undefined);
});

test("strips a trailing .md / .mdx extension", () => {
  assert.equal(parseClipUri("cabinet://new?file=Clips/Note.md").file, "Clips/Note");
  assert.equal(parseClipUri("cabinet://new?file=Note.mdx").file, "Note");
});

test("normalizes slashes and whitespace", () => {
  const clip = parseClipUri(
    `cabinet://new?file=${encodeURIComponent("  /Clips//Sub//Note/  ")}`,
  );
  assert.equal(clip.file, "Clips/Sub/Note");
});

test("rejects non-cabinet protocols", () => {
  assert.throws(
    () => parseClipUri("obsidian://new?file=A"),
    InvalidClipUriError,
  );
});

test("rejects cabinet hosts other than 'new'", () => {
  assert.throws(
    () => parseClipUri("cabinet://open?file=A"),
    InvalidClipUriError,
  );
});

test("rejects .. and . path segments", () => {
  assert.throws(
    () => parseClipUri(`cabinet://new?file=${encodeURIComponent("../evil")}`),
    InvalidClipUriError,
  );
  assert.throws(
    () => parseClipUri(`cabinet://new?file=${encodeURIComponent("a/./b")}`),
    InvalidClipUriError,
  );
});

test("rejects a missing or empty page path", () => {
  assert.throws(() => parseClipUri("cabinet://new"), InvalidClipUriError);
  assert.throws(
    () => parseClipUri("cabinet://new?file="),
    InvalidClipUriError,
  );
});

test("rejects a non-URI string", () => {
  assert.throws(() => parseClipUri("not a uri"), InvalidClipUriError);
});
