import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createDataDirChangeDetector,
  readConfiguredDataDir,
} from "../scripts/stale-process-watch.mjs";
import {
  STALE_PROCESS_HEADER,
  isStaleProcessResponse,
} from "../src/lib/api/stale-process";
import { dataDirChangedSinceBoot } from "../src/lib/runtime/runtime-config";
import { GET as getHealth } from "../src/app/api/health/route";
import { dedupFetch, resetDedupFetch } from "../src/lib/api/dedup-fetch";

test("dataDirChangedSinceBoot compares normalized absolute paths", () => {
  const boot = path.join(os.tmpdir(), "cabinet-stale-boot");
  assert.equal(dataDirChangedSinceBoot(boot, boot), false);
  assert.equal(dataDirChangedSinceBoot(path.join(boot, "."), boot), false);
  assert.equal(dataDirChangedSinceBoot(`${boot}-next`, boot), true);
});

test("isStaleProcessResponse requires the retryable status and marker", () => {
  assert.equal(
    isStaleProcessResponse(
      new Response(null, {
        status: 503,
        headers: { [STALE_PROCESS_HEADER]: "1" },
      })
    ),
    true
  );
  assert.equal(
    isStaleProcessResponse(
      new Response(null, { status: 500, headers: { [STALE_PROCESS_HEADER]: "1" } })
    ),
    false
  );
  assert.equal(isStaleProcessResponse(new Response(null, { status: 503 })), false);
});

test("dedupFetch detects a stale HEAD response without consuming it", async () => {
  const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const delays: number[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      dispatchEvent: () => true,
      location: { reload: () => {} },
      setTimeout: (_callback: () => void, delay: number) => {
        delays.push(delay);
        return 1;
      },
    },
  });
  globalThis.fetch = async () =>
    new Response(null, {
      status: 503,
      headers: { [STALE_PROCESS_HEADER]: "1" },
    });

  try {
    const response = await dedupFetch("/stale", { method: "HEAD" });
    assert.equal(response.status, 503);
    assert.deepEqual(delays, [800]);
  } finally {
    resetDedupFetch();
    if (fetchDescriptor) Object.defineProperty(globalThis, "fetch", fetchDescriptor);
    else Reflect.deleteProperty(globalThis, "fetch");
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("health returns the stale-process protocol after the data directory changes", async () => {
  const previous = process.env.CABINET_DATA_DIR;
  process.env.CABINET_DATA_DIR = path.join(previous || os.tmpdir(), "replacement");
  try {
    const response = await getHealth();
    assert.ok(response);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get(STALE_PROCESS_HEADER), "1");
    assert.equal((await response.json()).code, "STALE_PROCESS");
  } finally {
    process.env.CABINET_DATA_DIR = previous;
  }
});

test("readConfiguredDataDir follows env, persisted config, and default precedence", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cabinet-stale-config-"));
  try {
    fs.writeFileSync(
      path.join(projectRoot, ".cabinet-install.json"),
      JSON.stringify({ dataDir: "persisted-data" })
    );
    assert.equal(
      readConfiguredDataDir(projectRoot, {} as NodeJS.ProcessEnv),
      path.join(projectRoot, "persisted-data")
    );
    assert.equal(
      readConfiguredDataDir(projectRoot, {
        CABINET_DATA_DIR: "env-data",
      } as unknown as NodeJS.ProcessEnv),
      path.join(projectRoot, "env-data")
    );
    fs.writeFileSync(path.join(projectRoot, ".cabinet-install.json"), "invalid");
    assert.equal(
      readConfiguredDataDir(projectRoot, {} as NodeJS.ProcessEnv),
      path.join(projectRoot, "data")
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("createDataDirChangeDetector emits each transition once without process signals", () => {
  const transitions: Array<[string, string]> = [];
  const initial = path.join(os.tmpdir(), "cabinet-stale-a");
  const next = path.join(os.tmpdir(), "cabinet-stale-b");
  const detect = createDataDirChangeDetector(initial, (current: string, previous: string) => {
    transitions.push([current, previous]);
  });

  assert.equal(detect(initial), false);
  assert.equal(detect(next), true);
  assert.equal(detect(next), false);
  assert.equal(detect(initial), true);
  assert.deepEqual(transitions, [
    [next, initial],
    [initial, next],
  ]);
});
