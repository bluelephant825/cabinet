import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { handleDeepLink } from "./deep-links";

type FetchCall = { url: string; init?: { method?: string; body?: string } };
type Dispatched = { type: string; detail?: unknown };

let fetchCalls: FetchCall[];
let fetchResponse: { ok: boolean; status: number; body: unknown };
let dispatched: Dispatched[];
let replaceStateCalls: string[];

const g = globalThis as Record<string, unknown>;

function installStubs() {
  fetchCalls = [];
  dispatched = [];
  replaceStateCalls = [];
  fetchResponse = {
    ok: true,
    status: 200,
    body: { ok: true, path: "Clips/Hello", title: "Hello", silent: false },
  };

  g.fetch = async (url: string, init?: { method?: string; body?: string }) => {
    fetchCalls.push({ url, init });
    return {
      ok: fetchResponse.ok,
      status: fetchResponse.status,
      json: async () => fetchResponse.body,
    } as Response;
  };

  g.PopStateEvent = class PopStateEvent extends Event {};

  g.window = {
    history: {
      replaceState: (_state: unknown, _title: string, url: string) => {
        replaceStateCalls.push(url);
      },
    },
    dispatchEvent: (event: Event) => {
      dispatched.push({
        type: event.type,
        detail: (event as CustomEvent).detail,
      });
      return true;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

beforeEach(installStubs);

test("cabinet://new posts the uri to /api/clip", async () => {
  const uri = "cabinet://new?file=Clips/Hello&content=Hi";
  await handleDeepLink(uri);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "/api/clip");
  assert.equal(fetchCalls[0].init?.method, "POST");
  assert.deepEqual(JSON.parse(fetchCalls[0].init?.body ?? "{}"), { uri });
});

test("non-cabinet urls are ignored without a fetch", async () => {
  await handleDeepLink("obsidian://new?file=A");
  assert.equal(fetchCalls.length, 0);
  assert.equal(replaceStateCalls.length, 0);
});

test("success toasts and navigates to /room/<path> when not silent", async () => {
  await handleDeepLink("cabinet://new?file=Clips/Hello&content=Hello");
  const toast = dispatched.find((d) => d.type === "cabinet:toast");
  assert.deepEqual(toast?.detail, { kind: "success", message: "Saved clip: Hello" });
  assert.deepEqual(replaceStateCalls, ["/room/Clips/Hello"]);
  assert.ok(dispatched.some((d) => d.type === "popstate"));
});

test("silent clips skip navigation", async () => {
  fetchResponse.body = { ok: true, path: "Clips/Quiet", title: "Quiet", silent: true };
  await handleDeepLink("cabinet://new?file=Clips/Quiet&content=Hi&silent=true");
  assert.equal(replaceStateCalls.length, 0);
});

test("a failed clip toasts the server error", async () => {
  fetchResponse = { ok: false, status: 422, body: { error: "Clipboard is empty or unreadable." } };
  await handleDeepLink("cabinet://new?file=Clips/Fail&clipboard=true");
  const toast = dispatched.find((d) => d.type === "cabinet:toast");
  assert.deepEqual(toast?.detail, {
    kind: "error",
    message: "Clipboard is empty or unreadable.",
  });
  assert.equal(replaceStateCalls.length, 0);
});

test("the same url delivered twice within 2s is de-duplicated", async () => {
  const uri = "cabinet://new?file=Clips/Dupe&content=Hi";
  await handleDeepLink(uri);
  await handleDeepLink(uri);
  assert.equal(fetchCalls.length, 1);
});
