import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { build } from "esbuild";

const appOrigin = process.env.CABINET_BROWSER_TEST_ORIGIN;

async function browserApi(route: string, body?: unknown) {
  const response = await fetch(`${appOrigin}/api/browser/${route}`, body === undefined ? undefined : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(response.ok, true, JSON.stringify(result));
  return result;
}

function makeTone() {
  const samples = 8000 * 10;
  const wav = Buffer.alloc(44 + samples);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + samples, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(8000, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples, 40);
  wav.fill(128, 44);
  return wav;
}

test("suspended render retries initialize only the committed audio source", {
  skip: !appOrigin,
  timeout: 30_000,
}, async (t) => {
  const status = await browserApi("status");
  assert.equal(status.status, "running", "use the existing daemon-owned browser; never launch another browser");
  const source = fs.readFileSync(new URL("../src/app/media-player/page.tsx", import.meta.url), "utf8");
  const sourceFile = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = sourceFile.statements.filter((node) =>
    ts.isFunctionDeclaration(node) && ["AudioPlayer", "formatMediaTime"].includes(node.name?.text ?? ""),
  ).map((node) => node.getText(sourceFile)).join("\n");
  const bundled = await build({
    stdin: {
      contents: `
        import React, { Suspense, useEffect, useRef, useState } from "react";
        import { createRoot } from "react-dom/client";
        const Loader2 = () => null;
        const Play = () => null;
        const Pause = () => null;
        ${declarations}
        const audioElements = [];
        const originalCreate = document.createElement.bind(document);
        document.createElement = (...args) => {
          const element = originalCreate(...args);
          if (args[0] === "audio") {
            element.muted = true;
            audioElements.push(element);
          }
          return element;
        };
        let ready = false;
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        function Gate() {
          if (!ready) throw gate;
          return null;
        }
        const root = createRoot(document.getElementById("root"));
        const LegacyPlayer = () => <audio src="/tone.wav" autoPlay />;
        const Player = new URLSearchParams(location.search).has("legacy") ? LegacyPlayer : AudioPlayer;
        root.render(<Suspense fallback={<div>Loading</div>}><Player src="/tone.wav" /><Gate /></Suspense>);
        window.audioTest = {
          snapshot: () => ({
            ready,
            media: audioElements.map(audio => ({
              src: audio.getAttribute("src") || "",
              paused: audio.paused,
              connected: audio.isConnected,
              time: audio.currentTime,
            })),
          }),
          pause: () => document.querySelector("audio")?.pause(),
          play: () => document.querySelector("audio")?.play(),
          unmount: () => root.unmount(),
        };
        setTimeout(() => { ready = true; release(); }, 300);
      `,
      resolveDir: fileURLToPath(new URL("..", import.meta.url)),
      loader: "tsx",
      sourcefile: "audio-browser-regression.tsx",
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const script = bundled.outputFiles[0].contents;
  const tone = makeTone();
  const server = http.createServer((request, response) => {
    if (request.url === "/app.js") {
      response.writeHead(200, { "content-type": "application/javascript" }).end(script);
    } else if (request.url === "/tone.wav") {
      response.writeHead(200, { "content-type": "audio/wav", "content-length": tone.length }).end(tone);
    } else {
      response.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><html><head><title>Cabinet Audio Regression</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/`;
  const { tab } = await browserApi("tabs", { url: `${url}?legacy=1` });
  t.after(async () => { await browserApi(`tabs/${tab.id}/close`, {}); });
  const evaluate = async (expression: string) =>
    (await browserApi(`tabs/${tab.id}/evaluate`, { expression })).result;
  const waitForCommit = async () => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const snapshot = await evaluate("window.audioTest?.snapshot()");
      if (snapshot?.ready && snapshot.media.some((audio: { connected: boolean; src: string }) => audio.connected && audio.src)) {
        return snapshot;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail("suspended render did not commit");
  };
  const legacy = await waitForCommit();
  assert.ok(legacy.media.some((audio: { connected: boolean; src: string }) => !audio.connected && audio.src), JSON.stringify(legacy));
  await browserApi(`tabs/${tab.id}/navigate`, { url });
  let snapshot = await waitForCommit();
  assert.ok(snapshot.media.length >= 2, "fixture exercised discarded audio creation");
  assert.equal(snapshot.media.filter((audio: { src: string }) => audio.src).length, 1, JSON.stringify(snapshot));
  assert.ok(snapshot.media.filter((audio: { connected: boolean }) => !audio.connected).every((audio: { src: string; paused: boolean }) => !audio.src && audio.paused), JSON.stringify(snapshot));
  t.diagnostic(JSON.stringify({ legacy, fixed: snapshot }));
  await evaluate("window.audioTest.pause()");
  snapshot = await evaluate("window.audioTest.snapshot()");
  assert.ok(snapshot.media.every((audio: { paused: boolean }) => audio.paused), JSON.stringify(snapshot));
  await evaluate("window.audioTest.unmount()");
  snapshot = await evaluate("window.audioTest.snapshot()");
  assert.ok(snapshot.media.every((audio: { src: string; paused: boolean }) => !audio.src && audio.paused), JSON.stringify(snapshot));
});
