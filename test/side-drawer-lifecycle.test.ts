import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UseSideDrawer, UseSideDrawerOptions } from "../src/hooks/use-side-drawer";

const source = fs.readFileSync(new URL("../src/hooks/use-side-drawer.ts", import.meta.url), "utf8");
const sourceFile = ts.createSourceFile("use-side-drawer.ts", source, ts.ScriptTarget.Latest, true);
const declaration = sourceFile.statements.find((node) =>
  ts.isFunctionDeclaration(node) && node.name?.text === "useSideDrawer",
);
assert.ok(declaration);
const script = ts.transpileModule(declaration.getText(sourceFile).replace("export ", ""), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function createDrawerHarness(isMobile: boolean) {
  const states: unknown[] = [];
  const effects: Array<{ deps: unknown[]; cleanup?: () => void }> = [];
  const pending: Array<() => void> = [];
  const frames = new Map<number, () => void>();
  let cursor = 0;
  let changed = false;
  let frameId = 0;
  const drawer = vm.runInNewContext(`${script}\nuseSideDrawer`, {
    window: {
      localStorage: { getItem: () => null, setItem: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    useIsMobile: () => isMobile,
    useState: (initial: unknown) => {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
      return [states[index], (next: unknown) => {
        if (!Object.is(states[index], next)) {
          states[index] = next;
          changed = true;
        }
      }];
    },
    useRef: (initial: unknown) => {
      const index = cursor++;
      if (!(index in states)) states[index] = { current: initial };
      return states[index];
    },
    useCallback: (callback: unknown) => { cursor++; return callback; },
    useEffect: (callback: () => (() => void) | undefined, deps: unknown[]) => {
      const index = cursor++;
      const prior = effects[index];
      if (prior && deps.every((dep, i) => Object.is(dep, prior.deps[i]))) return;
      pending.push(() => {
        prior?.cleanup?.();
        effects[index] = { deps, cleanup: callback() };
      });
    },
    requestAnimationFrame: (callback: () => void) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  }) as (options: UseSideDrawerOptions) => UseSideDrawer;

  return (isOpen: boolean, keepMounted: boolean) => {
    let result: UseSideDrawer;
    let renders = 0;
    do {
      assert.ok(++renders < 20, "drawer lifecycle must not enter a render loop");
      changed = false;
      cursor = 0;
      result = drawer({ isOpen, keepMounted, storageKey: "test-width" });
      pending.splice(0).forEach((effect) => effect());
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback());
    } while (changed);
    return result;
  };
}

for (const isMobile of [false, true]) {
  test(`a retained ${isMobile ? "mobile" : "desktop"} drawer survives repeated close/reopen cycles`, () => {
    const render = createDrawerHarness(isMobile);
    assert.equal(render(false, true).shouldRender, false);
    assert.equal(render(true, true).shouldRender, true);
    for (let cycle = 0; cycle < 3; cycle++) {
      const closed = render(false, true);
      assert.equal(closed.isOpen, false);
      assert.equal(closed.expanded, false);
      closed.onWrapperTransitionEnd({ target: null, currentTarget: null, propertyName: "width" } as unknown as React.TransitionEvent);
      assert.equal(render(false, true).shouldRender, true);
      assert.equal(render(true, true).shouldRender, true);
    }
  });
}

test("ordinary drawers still unmount after closing", () => {
  const render = createDrawerHarness(false);
  assert.equal(render(true, false).shouldRender, true);
  const closed = render(false, false);
  closed.onWrapperTransitionEnd({ target: null, currentTarget: null, propertyName: "width" } as unknown as React.TransitionEvent);
  assert.equal(render(false, false).shouldRender, false);
});

const shellSource = fs.readFileSync(new URL("../src/components/ui/side-drawer.tsx", import.meta.url), "utf8");
const shellFile = ts.createSourceFile("side-drawer.tsx", shellSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const shellDeclaration = shellFile.statements.find((node) =>
  ts.isFunctionDeclaration(node) && node.name?.text === "SideDrawer",
);
assert.ok(shellDeclaration);
const shellScript = ts.transpileModule(shellDeclaration.getText(shellFile).replace("export ", ""), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText;
const DrawerShell = vm.runInNewContext(`${shellScript}\nSideDrawer`, {
  React,
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
  useLocale: () => ({ t: (key: string) => key }),
}) as React.ComponentType<{ drawer: UseSideDrawer; onScrimClick: () => void; children?: React.ReactNode }>;

for (const isMobile of [false, true]) {
  test(`a closed retained ${isMobile ? "mobile" : "desktop"} drawer hides and disables its controls`, () => {
    const render = createDrawerHarness(isMobile);
    render(true, true);
    const drawer = render(false, true);
    const markup = renderToStaticMarkup(React.createElement(DrawerShell, {
      drawer,
      onScrimClick: () => {},
    }, React.createElement("button", null, "Chat control")));
    assert.match(markup, /inert=""/);
    assert.match(markup, /aria-hidden="true"/);
    assert.match(markup, /Chat control/);
    if (isMobile) assert.equal((markup.match(/ hidden=""/g) ?? []).length, 2);
    else {
      assert.match(markup, /overflow-hidden/);
      assert.match(markup, /width:0/);
    }
  });
}
