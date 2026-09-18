import test from "node:test";
import assert from "node:assert/strict";
import { planCommand } from "../scripts/browser-tool";

test("status/tabs/extensions are GET routes", () => {
  assert.deepEqual(planCommand("status", []), { method: "GET", path: "status" });
  assert.deepEqual(planCommand("tabs", []), { method: "GET", path: "tabs" });
  assert.deepEqual(planCommand("extensions", []), { method: "GET", path: "extensions" });
});

test("open posts the url to /tabs", () => {
  assert.deepEqual(planCommand("open", ["https://example.com"]), {
    method: "POST",
    path: "tabs",
    body: { url: "https://example.com" },
  });
});

test("navigate posts the url under the tab", () => {
  assert.deepEqual(planCommand("navigate", ["ABC123", "https://a.b"]), {
    method: "POST",
    path: "tabs/ABC123/navigate",
    body: { url: "https://a.b" },
  });
});

test("activate/close/back/forward/reload map to tab sub-routes", () => {
  for (const cmd of ["activate", "close", "back", "forward", "reload"] as const) {
    assert.deepEqual(planCommand(cmd, ["T1"]), {
      method: "POST",
      path: `tabs/T1/${cmd}`,
    });
  }
});

test("eval posts an inline expression, '-' defers to stdin", () => {
  assert.deepEqual(planCommand("eval", ["T1", "document.title"]), {
    method: "POST",
    path: "tabs/T1/evaluate",
    body: { expression: "document.title" },
  });
  assert.deepEqual(planCommand("eval", ["T1", "-"]), {
    method: "POST",
    path: "tabs/T1/evaluate",
    expressionFromStdin: true,
  });
});

test("text/html hit extract (html adds ?html=1)", () => {
  assert.deepEqual(planCommand("text", ["T1"]), {
    method: "GET",
    path: "tabs/T1/extract",
  });
  assert.deepEqual(planCommand("html", ["T1"]), {
    method: "GET",
    path: "tabs/T1/extract?html=1",
  });
});

test("screenshot writes a PNG, defaulting to a /tmp path", () => {
  assert.deepEqual(planCommand("screenshot", ["T1", "/tmp/x.png"]), {
    method: "GET",
    path: "tabs/T1/screenshot",
    screenshotOut: "/tmp/x.png",
  });
  const planned = planCommand("screenshot", ["T1"]);
  assert.equal(planned.method, "GET");
  assert.equal(planned.path, "tabs/T1/screenshot");
  assert.match(planned.screenshotOut ?? "", /^\/tmp\/cabinet-browser-T1-\d+\.png$/);
});

test("install-extension posts idOrUrl", () => {
  assert.deepEqual(planCommand("install-extension", ["bcmnckabbmlnklolblobnobnlioneebd"]), {
    method: "POST",
    path: "extensions",
    body: { idOrUrl: "bcmnckabbmlnklolblobnobnlioneebd" },
  });
});

test("missing args and unknown commands are invalid", () => {
  for (const argv of [
    ["open"],
    ["navigate", "T1"],
    ["eval", "T1"],
    ["screenshot"],
    ["install-extension"],
    ["bogus"],
    [],
  ]) {
    assert.throws(() => planCommand(argv[0], argv.slice(1)), /required|Unknown command/);
  }
});

test("extra trailing args are rejected", () => {
  assert.throws(() => planCommand("status", ["x"]), /Unexpected argument/);
  assert.throws(() => planCommand("open", ["https://a.b", "x"]), /Unexpected argument/);
});
