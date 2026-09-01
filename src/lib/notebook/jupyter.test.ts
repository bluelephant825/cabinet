import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DATA_DIR } from "@/lib/storage/path-utils";
import {
  findActiveJupyterServer,
  fromJupyterPath,
  isAllowedJupyterProxyRequest,
  toJupyterPath,
} from "./jupyter";

test("Jupyter discovery skips malformed and stale runtime files with a mocked status probe", async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cabinet-jupyter-"));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(runtimeDir, "jpserver-bad.json"), JSON.stringify({ url: "https://example.com/", token: "leak", port: 443 }));
  fs.writeFileSync(path.join(runtimeDir, "jpserver-stale.json"), JSON.stringify({ url: "http://127.0.0.1:9001/", token: "stale", port: 9001 }));
  fs.writeFileSync(path.join(runtimeDir, "jpserver-live.json"), JSON.stringify({ url: "http://localhost:9002/base", token: "live", port: 9002, root_dir: "/tmp/notebooks" }));
  const now = new Date("2026-09-01T12:00:00Z");
  fs.utimesSync(path.join(runtimeDir, "jpserver-stale.json"), now, new Date(now.getTime() + 2_000));
  fs.utimesSync(path.join(runtimeDir, "jpserver-live.json"), now, new Date(now.getTime() + 1_000));

  const probes: string[] = [];
  const server = await findActiveJupyterServer({
    runtimeDir,
    fetchImpl: (async (input) => {
      probes.push(String(input));
      return new Response(null, { status: String(input).includes("9002") ? 200 : 503 });
    }) as typeof fetch,
  });

  assert.equal(server?.token, "live");
  assert.equal(server?.url, "http://localhost:9002/base/");
  assert.deepEqual(probes.map((url) => new URL(url).searchParams.get("token")), ["stale", "live"]);
  assert.equal(probes.some((url) => url.includes("example.com")), false);
});

test("Jupyter proxy allowlist is method and path bounded", () => {
  assert.equal(isAllowedJupyterProxyRequest("GET", "api/sessions"), true);
  assert.equal(isAllowedJupyterProxyRequest("POST", "api/kernels/kernel_1/restart"), true);
  assert.equal(isAllowedJupyterProxyRequest("DELETE", "api/sessions/session-1"), true);
  assert.equal(isAllowedJupyterProxyRequest("GET", "api/contents/../../etc/passwd"), false);
  assert.equal(isAllowedJupyterProxyRequest("POST", "api/kernels/x/channels"), false);
  assert.equal(isAllowedJupyterProxyRequest("PUT", "api/sessions"), false);
});

test("session path mapping round trips managed and authorized mounted notebooks", () => {
  const managedVirtual = "room/analysis.ipynb";
  const managedJupyter = toJupyterPath(managedVirtual, path.dirname(DATA_DIR));
  assert.equal(fromJupyterPath(managedJupyter, path.dirname(DATA_DIR)), managedVirtual);

  const mount = path.join(os.tmpdir(), "Cabinet Drive");
  const mounted = path.join(mount, "reports", "analysis.ipynb");
  const encoded = `gdrive:${mounted}`;
  const mapped = toJupyterPath(encoded, os.tmpdir(), [mount]);
  assert.equal(fromJupyterPath(mapped, os.tmpdir(), [mount]), encoded);
  assert.throws(() => toJupyterPath(`gdrive:${path.join(os.tmpdir(), "private.ipynb")}`, os.tmpdir(), [mount]), /authorized mount/);
  assert.throws(() => fromJupyterPath("../escape.ipynb", os.tmpdir(), [mount]), /escaped/);
});
