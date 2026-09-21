# Cabinet on Chromium (host migration)

Cabinet's desktop shell is migrating from Electron to a thin Chromium fork.
The fork — kept in the sibling `cabinet-chromium` repo as a small patch stack
against a pinned Chromium release — hosts the Cabinet React/Next UI as its
window shell and positions real tab WebContents inside it. This document
describes the seam that makes the app host-agnostic and the daemon's host
mode. For the sidecar (engine) side see `docs/BROWSER.md`.

## The seam: `src/lib/host/`

Every privileged call from the renderer goes through `getHost()`, which
returns a `CabinetHost` for the detected runtime:

```
window.cabinetHost                       -> "chromium"  (fork binding)
window.CabinetDesktop.runtime "electron" -> "electron"  (preload bridge)
otherwise                                -> "web"
```

```ts
interface CabinetHost {
  kind, platform, capabilities
  tabs        -> daemon /browser/* (CDP) — identical on all hosts
  extensions  -> daemon /browser/* (CDP) — identical on all hosts
  browser     -> engine lifecycle (status/launch/download/window bounds)
  layout      -> setContentBounds() — chromium only; positions the active
                 tab's WebContents inside the shell window
  windows     -> open/focus/relaunch/onFullscreenChanged
  system      -> openExternal/openPath/preferredLanguages/showToast/uninstall
  files?      -> content-root read/write (electron bridge, or /api/assets
                 over loopback on chromium; absent on web)
  pdf?        -> native printToPDF + save dialog (absent -> window.print())
  electron?   -> Electron-only extras (WebContentsView surface + window
                 geometry), present only when kind === "electron"
}
```

Call sites check `host.capabilities.*` (or optional namespaces) instead of
sniffing `window.CabinetDesktop`. Event streams that already have a channel
(daemon `browser` events) stay on `useDaemonChannel` — the host covers
commands and queries only.

## Why the fork, and what it replaces

Electron cannot host the Chrome extension platform, and the current answer —
a Chrome-for-Testing sidecar driven over CDP in a separate OS window — makes
Cabinet feel like two apps sharing a screen. The fork inverts that: one
window, owned by Chromium, with the Cabinet UI as its shell.

```
Cabinet Chromium window
├── shell WebContents -> http://127.0.0.1:<appPort>/  (the unmodified app)
│     window.cabinetHost.*  (binding injected ONLY here)
└── active tab WebContents, positioned at the bounds the shell reports
      via host.layout.setContentBounds()
```

What disappears in that world: the WebContentsView in `browser-views.cjs`,
the window-geometry push channel, the macOS hide/unhide AppleScript/`open -b`
dance, the focus protocol, and the floating-window bounds sync — all replaced
by one in-window layout call. Internal content (`/api/assets`, `data:` tag
cloud, embedded editors) is same-origin with the shell and renders in a
plain `<iframe>`; external pages are real tabs driven by the daemon's
existing CDP session, so `server/browser/`, the `/browser/*` routes, and the
`cabinet-browser` agent CLI are unchanged.

## Daemon host mode

`ChromiumManager` gains `hostMode` (env `CABINET_BROWSER_HOST_MODE=1` or
`browser.hostMode` in `cabinet-config.json`). In host mode:

- launch args gain `--cabinet-ui-url=<app origin>` (a flag, not a tab);
- `setWindowBounds`/`focusWindow` on the facade become no-ops — in-window
  layout replaces the floating window;
- `GET /browser/status` reports `hostMode: true`;
- `--remote-debugging-pipe` is retained, so the daemon keeps driving tabs
  and extensions over CDP inside the fork exactly as it does the sidecar.

## P1 interim: the host extension

Before the fork exists, Cabinet can be hosted inside the sidecar's own
window by a generated MV3 extension (`server/browser/host-extension.ts`),
enabled via `CABINET_BROWSER_HOST_EXTENSION=1` or `browser.hostExtension`
in `cabinet-config.json`. On every sidecar launch the daemon regenerates
`<appdata>/Browser/HostExtension/` (app origin + platform + embed token
baked in) and loads it with `Extensions.loadUnpacked`; unpacked extensions
persist in the profile, so a relaunch only rewrites files when inputs
changed and reinstalls only then.

What it provides:

- **New tab = Cabinet** — `chrome_url_overrides.newtab` redirects to the
  app origin (a real top-level navigation, so auth/cookies behave
  normally).
- **`window.cabinetHost` on the app origin** — a MAIN-world content script
  installs the same binding the fork will inject natively (windows.open /
  windows.focus / system.openExternal), relayed through an isolated-world
  content script to the service worker's `chrome.tabs`/`chrome.windows`.
  `getHost()` therefore returns `"chromium"` inside Chrome and the same
  `chromium` adapter is exercised end-to-end. `layout` is deliberately not
  injected (Chrome owns the window chrome), so `capabilities.layout` is
  false and `browser-view.tsx` renders a "this page is a browser tab"
  surface instead of syncing bounds.
- **Side panel** — iframes the app. The app emits no framing headers, so
  no CSP change is needed. Auth is the wrinkle: the `kb-auth` cookie is
  `SameSite=Lax`, which is never sent in a cross-site iframe, so the panel
  would render a login page that can never complete. The fix is a CHIPS
  partitioned session: `/api/auth/login?embedToken=<token>` mints a
  `SameSite=None; Secure; Partitioned` cookie instead of the Lax one. The
  token is a random per-install secret in `.cabinet-state/
  browser-host-extension.json` (`src/lib/auth/embed-token.ts`), baked into
  `sidepanel.html` at generation time and never exposed by any route —
  without it the partitioned path is unavailable, so third-party pages
  cannot weaken their way into a cross-site session. The partitioned
  cookie is scoped to the extension's top-level context only; the
  first-party session and its CSRF posture are untouched.
- **Popup + command** — action popup and `open-cabinet` (Cmd/Ctrl+Shift+Y)
  open the app in a tab.

Status surfaces in `GET /browser/status` as
`hostExtension: { enabled, id }`.

Known limits (by design for a time-boxed interim): Chrome's tab strip and
omnibox stay visible; tabs open as real Chrome tabs rather than in-window
content; the panel needs one extra login when `KB_PASSWORD` is set. This
is a stepping stone to validate the seam and daily-drive the single-window
UX — not the target architecture.

## Dev-build Gatekeeper bubble

On macOS 15+, syspolicyd scans every newly-created executable image on first
load. `out/dev/libchrome_dll.dylib` is a ~4 GB ad-hoc-signed dylib that lives
outside the app bundle, and each `autoninja` relink produces a new file, so
the next browser launch can show a modal "Verifying libchrome_dll.dylib"
bubble while Gatekeeper re-scans it. This is a dev-build artifact only: the
release path (P4) ships a Developer ID-signed, notarized bundle, which is
exempt.

To suppress it on a dev machine, exempt the toolchain that spawns the
daemon — the exemption is inherited by descendants:

1. `sudo spctl developer-mode enable-terminal`
2. System Settings -> Privacy & Security -> Developer Tools -> enable the
   app that runs `npm run dev:all`/`dev:daemon` (Terminal, iTerm, or the
   IDE).
3. Restart the dev servers from that app. A daemon detached to launchd
   (its `bash` ancestor has `ppid 1`) has no Developer Tools ancestor and
   keeps triggering the scan — it must be a descendant of a listed tool.

## Privilege boundary

`window.cabinetHost` exists only in the shell WebContents, injected only when
its origin matches the configured `--cabinet-ui-url` origin (loopback).
Ordinary tabs and third-party extensions never see it. That is the same
strength as today's Electron preload boundary — an upgrade path to a
`chrome://cabinet` WebUI that embeds the app unprivileged is documented in
`cabinet-chromium/docs/DESIGN.md` but is not required for the POC.

## Roadmap

1. **P0 (done in this change):** the `CabinetHost` seam, daemon host mode,
   and the `cabinet-chromium` repo skeleton (patch stack, GN args, scripts).
2. **P1 (done):** "Cabinet-in-Chrome" — a generated MV3 extension loaded
   into the existing sidecar (new-tab override + side panel + a real
   `window.cabinetHost` binding via content scripts). See "P1 interim:
   the host extension" above.
3. **P2:** one unmodified Chromium build on this machine (component build;
   rented M4 Pro as fallback) to prove build feasibility.
4. **P3:** host-mode patches — shell WebContents, in-window content bounds,
   `window.cabinetHost`. Acceptance = the POC checklist in
   `cabinet-chromium/docs/UPGRADE.md`.
5. **P4:** launcher + packaging (port `startEmbeddedCabinet()` to a bundled
   Node launcher; codesign/notarize; DMG/ZIP replace Forge).
6. **P5:** Electron removal.
