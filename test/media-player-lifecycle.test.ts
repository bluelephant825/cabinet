import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync(new URL("../src/app/media-player/page.tsx", import.meta.url), "utf8");
const sourceFile = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = sourceFile.statements.filter((node) =>
  ts.isFunctionDeclaration(node) && ["AudioPlayer", "formatMediaTime"].includes(node.name?.text ?? ""),
);
assert.equal(declarations.length, 2);
const componentScript = ts.transpileModule(
  `${declarations.map((node) => node.getText(sourceFile)).join("\n")}\nAudioPlayer;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } },
).outputText;

type ElementNode = { type: unknown; props: Record<string, unknown>; children: unknown[] };
type Ref = { current: unknown };
type Cleanup = () => void;

function findElement(node: unknown, type: string): ElementNode | undefined {
  if (!node || typeof node !== "object" || !("type" in node)) return;
  const element = node as ElementNode;
  if (element.type === type) return element;
  for (const child of element.children.flat()) {
    const found = findElement(child, type);
    if (found) return found;
  }
}

function createHarness() {
  const effects: Array<() => Cleanup | void> = [];
  const refs: Ref[] = [];
  const updates: Array<{ index: number; value: unknown }> = [];
  const revoked: string[] = [];
  let stateIndex = 0;
  let resolveBlob!: (value: Blob) => void;
  const blob = new Promise<Blob>((resolve) => { resolveBlob = resolve; });
  const component = vm.runInNewContext(componentScript, {
    React: {
      createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) =>
        ({ type, props: props ?? {}, children }),
    },
    Play: "Play",
    Pause: "Pause",
    Loader2: "Loader2",
    useRef: (current: unknown) => {
      const ref = { current };
      refs.push(ref);
      return ref;
    },
    useState: (initial: unknown) => {
      const index = stateIndex++;
      return [initial, (value: unknown) => updates.push({ index, value })];
    },
    useEffect: (effect: () => Cleanup | void) => effects.push(effect),
    fetch: async () => ({ ok: true, blob: () => blob }),
    URL: {
      createObjectURL: () => "blob:audio-fallback",
      revokeObjectURL: (url: string) => revoked.push(url),
    },
  }) as (props: { src: string }) => ElementNode;
  const tree = component({ src: "/api/assets/song.mp3" });
  const audioElement = findElement(tree, "audio")!;
  assert.ok(audioElement);
  const audio = {
    src: "",
    paused: true,
    playCalls: 0,
    pauseCalls: 0,
    loadCalls: 0,
    play() {
      this.playCalls += 1;
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.pauseCalls += 1;
      this.paused = true;
    },
    removeAttribute(name: string) {
      if (name === "src") this.src = "";
    },
    load() { this.loadCalls += 1; },
  };
  const cleanups: Cleanup[] = [];
  const commit = () => {
    (audioElement.props.ref as Ref).current = audio;
    for (const effect of effects) {
      const cleanup = effect();
      if (cleanup) cleanups.push(cleanup);
    }
  };
  const unmount = () => {
    (audioElement.props.ref as Ref).current = null;
    for (const cleanup of cleanups) cleanup();
  };
  return { tree, audioElement, audio, refs, updates, revoked, resolveBlob, commit, unmount };
}

async function flush() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("an uncommitted audio render has no source or declarative autoplay", () => {
  const harness = createHarness();
  assert.equal(harness.audioElement.props.src, undefined);
  assert.notEqual(harness.audioElement.props.autoPlay, true);
  assert.equal(harness.audio.playCalls, 0);
});

test("only the committed audio ref is loaded and started", () => {
  const harness = createHarness();
  harness.commit();
  assert.equal(harness.audio.src, "/api/assets/song.mp3");
  assert.equal(harness.audio.playCalls, 1);
});

test("unmount stops and releases audio even after React clears the ref", () => {
  const harness = createHarness();
  harness.commit();
  harness.unmount();
  assert.equal(harness.audio.paused, true);
  assert.equal(harness.audio.src, "");
  assert.equal(harness.audio.pauseCalls, 1);
  assert.equal(harness.audio.loadCalls, 1);
});

test("a blob fallback completing after unmount cannot revive the source", async () => {
  const harness = createHarness();
  harness.commit();
  (harness.audioElement.props.onError as () => void)();
  await flush();
  harness.unmount();
  const updateCount = harness.updates.length;
  harness.resolveBlob(new Blob(["audio"]));
  await flush();
  assert.deepEqual(harness.revoked, ["blob:audio-fallback"]);
  assert.equal(harness.updates.length, updateCount);
});

test("a rejected autoplay promise does not update an unmounted player", async () => {
  const harness = createHarness();
  let rejectPlay!: (error: Error) => void;
  harness.audio.play = () => new Promise<void>((_, reject) => { rejectPlay = reject; });
  harness.commit();
  harness.unmount();
  const updateCount = harness.updates.length;
  rejectPlay(new Error("playback aborted"));
  await flush();
  assert.equal(harness.updates.length, updateCount);
});
