/**
 * P1 host extension ("Cabinet in Chrome"): a thin generated MV3 extension
 * loaded unpacked into the CfT sidecar so Cabinet can be driven as a real
 * browser tab before the Chromium fork exists.
 *
 * What the generated extension provides:
 *   - chrome_url_overrides.newtab -> ntp.html redirects to the app origin,
 *     so a new tab IS the Cabinet app (top-level nav: auth works normally).
 *   - side_panel -> sidepanel.html iframes the app (auth via the embed
 *     token + partitioned cookie path in /api/auth/login).
 *   - A MAIN-world content script on the app origin installs a real
 *     window.cabinetHost binding (windows.open/focus, system.openExternal)
 *     backed by an isolated-world relay -> service worker -> chrome.tabs.
 *     This exercises the src/lib/host chromium adapter end-to-end with the
 *     same contract the fork's native binding will implement. No `layout`
 *     member is injected: capabilities.layout stays false and the app
 *     knows this window's chrome belongs to Chrome.
 *   - action popup + open-cabinet command.
 *
 * The directory is regenerated when inputs change (app origin, platform,
 * template version). Chrome derives an unpacked extension's id from its
 * absolute path, so the id is stable across launches at this fixed path;
 * we still persist the runtime id + a content hash in .cabinet-state so a
 * regenerated extension can be uninstalled + reloaded cleanly.
 *
 * Opt-in: CABINET_BROWSER_HOST_EXTENSION=1/true or browser.hostExtension
 * in cabinet-config.json. Not recorded in extensions.json — it is host
 * infrastructure, not a user-managed extension.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import {
  ensureHostExtensionEmbedToken,
  getHostExtensionEmbedToken,
} from "../../src/lib/auth/embed-token";
import { getManagedDataParentDir } from "../../src/lib/runtime/runtime-config";
import { cabinetConfigPath, hostExtensionDir } from "./paths";
import type { CDPClient } from "./cdp-client";

/** Bump when any generated file's template changes so the running extension
 *  is rebuilt + reloaded on the next launch. */
const TEMPLATE_VERSION = 5;

/** Enablement: env CABINET_BROWSER_HOST_EXTENSION=1/true or
 *  browser.hostExtension in cabinet-config.json (same parse pattern as
 *  readHostMode in chromium-manager). Re-read per call. */
export function isHostExtensionEnabled(): boolean {
  const env = process.env.CABINET_BROWSER_HOST_EXTENSION?.trim().toLowerCase();
  if (env === "1" || env === "true") return true;
  const configPath = cabinetConfigPath();
  if (configPath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
        browser?: { hostExtension?: unknown };
      };
      if (parsed?.browser?.hostExtension === true) return true;
    } catch {
      // missing/invalid config is fine
    }
  }
  return false;
}

type HostExtensionState = {
  embedToken?: string;
  extensionId?: string;
  contentHash?: string;
};

function statePath(): string {
  return path.join(
    getManagedDataParentDir(),
    ".cabinet-state",
    "browser-host-extension.json",
  );
}

function readState(): HostExtensionState {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeState(patch: Partial<HostExtensionState>): Promise<void> {
  const file = statePath();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const next = { ...readState(), ...patch };
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await fsp.rename(tmp, file);
}

// ---------------------------------------------------------------------------
// Generated file templates. Written as ES5-style script (the MAIN-world and
// isolated-world scripts run in the page/extension contexts directly), with
// __PLACEHOLDER__ substitution at generation time.
// ---------------------------------------------------------------------------

function manifestJson(matches: string[]): string {
  return `${JSON.stringify(
    {
      manifest_version: 3,
      name: "Cabinet",
      version: "0.1.0",
      description:
        "Hosts the Cabinet app inside this browser window (interim host extension).",
      // Minimal grant: tabs.create/update and windows.update need no
      // permission; only the sidePanel API does. host_permissions is needed
      // for the side panel's fetch() to the app origin (extension pages are
      // CORS-bound unless the target host is declared here).
      permissions: ["sidePanel"],
      host_permissions: matches,
      background: { service_worker: "sw.js" },
      chrome_url_overrides: { newtab: "ntp.html" },
      side_panel: { default_path: "sidepanel.html" },
      action: { default_popup: "popup.html", default_title: "Cabinet" },
      commands: {
        "open-cabinet": {
          suggested_key: { default: "Ctrl+Shift+Y", mac: "Command+Shift+Y" },
          description: "Open Cabinet",
        },
      },
      content_scripts: [
        {
          matches,
          js: ["bridge.js"],
          run_at: "document_start",
        },
        {
          matches,
          js: ["inject.js"],
          run_at: "document_start",
          world: "MAIN",
        },
      ],
    },
    null,
    2,
  )}\n`;
}

/** Isolated-world relay: window.postMessage <-> chrome.runtime.sendMessage.
 *  Only ever runs its body on the exact app origin (match patterns cannot
 *  express a port, so the manifest matches on host and this guards it). */
const BRIDGE_JS = `(function () {
  var ORIGIN = "__APP_ORIGIN__";
  if (location.origin !== ORIGIN) return;
  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data.__cabinetHost !== "req") return;
    var id = data.id;
    try {
      chrome.runtime.sendMessage(
        { __cabinetHost: "op", op: data.op, args: data.args || {} },
        function (res) {
          var err = chrome.runtime.lastError;
          if (err) res = { ok: false, error: err.message || "extension error" };
          window.postMessage(
            { __cabinetHost: "res", id: id, res: res },
            location.origin
          );
        }
      );
    } catch (err) {
      window.postMessage(
        {
          __cabinetHost: "res",
          id: id,
          res: { ok: false, error: String((err && err.message) || err) },
        },
        location.origin
      );
    }
  });
})();
`;

/** MAIN-world binding: installs window.cabinetHost, the exact surface the
 *  chromium adapter reads. Layout and pdf are deliberately absent — the
 *  adapter computes capabilities from member presence and falls back to
 *  web behaviour (iframe surface / window.print) for missing members. */
const INJECT_JS = `(function () {
  var ORIGIN = "__APP_ORIGIN__";
  if (location.origin !== ORIGIN) return;
  if (window.cabinetHost) return;
  var seq = 0;
  var pending = {};
  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data.__cabinetHost !== "res") return;
    var resolve = pending[data.id];
    if (!resolve) return;
    delete pending[data.id];
    resolve(data.res);
  });
  function call(op, args) {
    return new Promise(function (resolve) {
      var id = ++seq;
      pending[id] = resolve;
      window.postMessage(
        { __cabinetHost: "req", id: id, op: op, args: args || {} },
        location.origin
      );
      // The relay is best-effort; never leave a promise hanging if the
      // extension context was torn down (reload, update).
      setTimeout(function () {
        if (pending[id]) {
          delete pending[id];
          resolve({ ok: false, error: "timeout" });
        }
      }, 5000);
    });
  }
  window.cabinetHost = {
    platform: "__PLATFORM__",
    windows: {
      open: function (p) {
        return call("windows.open", { path: p });
      },
      focus: function () {
        return call("windows.focus");
      },
    },
    system: {
      openExternal: function (url) {
        return call("system.openExternal", { url: url });
      },
    },
  };
})();
`;

/** Service worker: cabinetHost op dispatch + commands. */
const SW_JS = `var APP_ORIGIN = "__APP_ORIGIN__";

function openCabinet() {
  chrome.tabs.create({ url: APP_ORIGIN + "/", active: true });
}

chrome.commands.onCommand.addListener(function (command) {
  if (command === "open-cabinet") openCabinet();
});

function resolveAppPath(p) {
  try {
    return new URL(String(p || "/"), APP_ORIGIN).href;
  } catch (err) {
    return APP_ORIGIN + "/";
  }
}

async function handleOp(op, args, sender) {
  switch (op) {
    case "windows.open": {
      await chrome.tabs.create({ url: resolveAppPath(args.path), active: true });
      return { ok: true };
    }
    case "windows.focus": {
      var tab = sender && sender.tab;
      if (tab) {
        try {
          await chrome.windows.update(tab.windowId, { focused: true });
          await chrome.tabs.update(tab.id, { active: true });
        } catch (err) {}
      }
      return { ok: true };
    }
    case "system.openExternal": {
      var url = String(args.url || "");
      if (!/^https?:/i.test(url)) return { ok: false, error: "bad scheme" };
      await chrome.tabs.create({ url: url, active: true });
      return { ok: true };
    }
    default:
      return { ok: false, error: "unsupported op: " + op };
  }
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.__cabinetHost !== "op") return;
  handleOp(msg.op, msg.args || {}, sender).then(
    function (res) {
      sendResponse(res == null ? { ok: true } : res);
    },
    function (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    }
  );
  return true; // async sendResponse
});
`;

const NTP_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="refresh" content="0; url=__APP_ORIGIN__/" />
    <title>Cabinet</title>
    <script src="ntp.js"></script>
  </head>
  <body>
    <p><a href="__APP_ORIGIN__/">Open Cabinet</a></p>
  </body>
</html>
`;

// MV3 extension pages run under script-src 'self' — inline <script> never
// executes, so all logic lives in external files.
const NTP_JS = `location.replace("__APP_ORIGIN__/");
`;

/** Side panel: auth-check first so the iframe lands on /login with the
 *  embedToken only when the partitioned-cookie login is actually needed. */
const SIDEPANEL_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      /* The frame fills the panel exactly — the app's own scroll containers
         do the scrolling. A taller min-height frame would swallow wheel
         events into inner overflow:hidden containers instead. */
      html, body { margin: 0; height: 100%; }
      iframe { display: block; width: 100%; height: 100%; border: 0; }
      #fallback { display: none; padding: 16px; font: 13px sans-serif; }
    </style>
  </head>
  <body>
    <iframe id="app" title="Cabinet"></iframe>
    <div id="fallback">
      <p>Cabinet is unreachable.</p>
      <p><a id="open" href="#">Open Cabinet in a tab</a></p>
    </div>
    <script src="sidepanel.js"></script>
  </body>
</html>
`;

const SIDEPANEL_JS = `var ORIGIN = "__APP_ORIGIN__";
var EMBED_TOKEN = "__EMBED_TOKEN__";
var frame = document.getElementById("app");
var fallback = document.getElementById("fallback");
document.getElementById("open").addEventListener("click", function (e) {
  e.preventDefault();
  chrome.tabs.create({ url: ORIGIN + "/", active: true });
});
fetch(ORIGIN + "/api/auth/check", { credentials: "include" })
  .then(function (res) { return res.ok ? res.json() : null; })
  .then(function (body) {
    if (!body) throw new Error("unreachable");
    frame.src = body.authenticated
      ? ORIGIN + "/"
      : ORIGIN + "/login?embedToken=" + encodeURIComponent(EMBED_TOKEN);
  })
  .catch(function () {
    frame.style.display = "none";
    fallback.style.display = "block";
  });
`;

const POPUP_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body { min-width: 180px; margin: 0; padding: 12px; font: 13px sans-serif; }
      h1 { font-size: 14px; margin: 0 0 8px; }
      button {
        display: block; width: 100%; margin: 6px 0; padding: 6px 8px;
        text-align: left; cursor: pointer;
      }
    </style>
  </head>
  <body>
    <h1>Cabinet</h1>
    <button id="open">Open Cabinet</button>
    <button id="panel">Toggle side panel</button>
    <script src="popup.js"></script>
  </body>
</html>
`;

const POPUP_JS = `var APP_ORIGIN = "__APP_ORIGIN__";
document.getElementById("open").addEventListener("click", function () {
  chrome.tabs.create({ url: APP_ORIGIN + "/", active: true });
  window.close();
});
document.getElementById("panel").addEventListener("click", function () {
  chrome.windows.getCurrent(function (win) {
    if (win && win.id != null) {
      chrome.sidePanel.open({ windowId: win.id }, function () {
        window.close();
      });
    } else {
      window.close();
    }
  });
});
`;

export type HostExtensionInfo = {
  dir: string;
  /** True when the on-disk files changed this generation (a running
   *  extension must be uninstalled + reloaded to pick them up). */
  changed: boolean;
  contentHash: string;
};

function substitute(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`__${key}__`).join(value);
  }
  return out;
}

/** Host match patterns for the app origin. Match patterns cannot carry a
 *  port, so this matches the whole loopback host; the runtime origin check
 *  inside bridge.js/inject.js narrows it back to the exact origin. */
export function appOriginMatches(origin: string): string[] {
  try {
    const url = new URL(origin);
    return [`${url.protocol}//${url.hostname}/*`];
  } catch {
    return [];
  }
}

/** Generate (or refresh) the extension directory. Writes only when content
 *  differs and reports whether anything changed. */
export async function ensureHostExtensionFiles(input: {
  appOrigin: string;
  platform: string;
}): Promise<HostExtensionInfo> {
  const dir = hostExtensionDir();
  const embedToken = ensureHostExtensionEmbedToken();
  const vars = {
    APP_ORIGIN: input.appOrigin,
    EMBED_TOKEN: embedToken,
    PLATFORM: input.platform,
  };
  const files: Record<string, string> = {
    "manifest.json": manifestJson(appOriginMatches(input.appOrigin)),
    "sw.js": substitute(SW_JS, vars),
    "bridge.js": substitute(BRIDGE_JS, vars),
    "inject.js": substitute(INJECT_JS, vars),
    "ntp.html": substitute(NTP_HTML, vars),
    "ntp.js": substitute(NTP_JS, vars),
    "sidepanel.html": substitute(SIDEPANEL_HTML, vars),
    "sidepanel.js": substitute(SIDEPANEL_JS, vars),
    "popup.html": substitute(POPUP_HTML, vars),
    "popup.js": substitute(POPUP_JS, vars),
    // Stamp so the hash covers the template version, not just inputs.
    ".template-version": String(TEMPLATE_VERSION),
  };
  const contentHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(files))
    .digest("hex");

  let changed = false;
  await fsp.mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    let existing: string | null = null;
    try {
      existing = await fsp.readFile(file, "utf8");
    } catch {}
    if (existing !== content) {
      await fsp.writeFile(file, content, "utf8");
      changed = true;
    }
  }
  return { dir, changed, contentHash };
}

/** Load the generated extension into the running browser over CDP. Reloads
 *  it when the generated files changed since the last successful load
 *  (unpacked extensions persist in the profile, so a plain loadUnpacked on
 *  relaunch hits "already loaded"). Returns the runtime extension id. */
export async function installHostExtension(
  cdp: CDPClient,
  info: HostExtensionInfo,
): Promise<string | null> {
  const state = readState();
  const alreadyLoadedSameBuild =
    !!state.extensionId && state.contentHash === info.contentHash;

  const load = async (): Promise<string | null> => {
    const result = (await cdp.send("Extensions.loadUnpacked", {
      path: info.dir,
    })) as { id?: string } | undefined;
    return result?.id ?? null;
  };

  try {
    const id = await load();
    await writeState({ extensionId: id ?? undefined, contentHash: info.contentHash });
    return id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/already|duplicate/i.test(message)) throw err;
    // Persisted in the profile from an earlier launch. Reload only when the
    // generated files actually changed.
    if (!info.changed || alreadyLoadedSameBuild) {
      return state.extensionId ?? null;
    }
    if (state.extensionId) {
      await cdp
        .send("Extensions.uninstall", { id: state.extensionId })
        .catch(() => {});
    }
    const id = await load();
    await writeState({ extensionId: id ?? undefined, contentHash: info.contentHash });
    return id;
  }
}

/** Token the login route verifies for the partitioned-cookie embedded
 *  login. Null until the extension has been generated once. */
export function hostExtensionEmbedToken(): string | null {
  return getHostExtensionEmbedToken();
}
