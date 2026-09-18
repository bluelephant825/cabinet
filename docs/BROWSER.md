# Cabinet Browser (Chromium sidecar)

Cabinet's browse mode and browser extensions run in a real **Chrome for Testing**
instance that the daemon downloads, launches, and drives over the Chrome
DevTools Protocol. Electron's own web stack cannot host the Chrome extension
platform (MV3 service workers, the `chrome.*` API surface, Web Store CRX
installs), so the old `electron-chrome-extensions` emulation was removed: there
are no Chrome API shims in the Electron shell, and none should come back.

## Architecture

```
Renderer (browser-view.tsx)
  → Next.js  /api/browser/[...op]      (route.ts: auth + origin forwarding)
  → daemon   /browser/*                (server/browser/http.ts, bearer token)
  → BrowserFacade                      (server/browser/facade.ts)
  → ChromiumManager                    (download, launch, status machine)
  → BrowserSession + CDPClient         (tabs, extract, screenshot, window bounds)
  → ExtensionManager                   (CRX install, Extensions.loadUnpacked)
  → Chrome for Testing                 (--remote-debugging-pipe, persistent profile)
```

CDP travels over `--remote-debugging-pipe` (file descriptors 3/4, NUL-framed
JSON) rather than a TCP port, so no port or websocket URL leaks to other
processes on the machine.

The Electron `WebContentsView` is **not** gone. It still renders content that
must stay inside the app: same-origin and loopback URLs (`/api/assets/...`,
editor/document views), `data:` URLs (tag cloud), `about:blank`, and anything
the sidecar declines.

## Engine routing

For each browse-mode URL the renderer picks an engine:

```
activeEngine = isSidecarUrl(url) && status.eligible && !preferNative
               ? "sidecar" : "native"
```

- `isSidecarUrl()` (`src/lib/browser/sidecar-client.ts`) is true for external
  `http(s)` URLs (host is not the app origin / loopback) and for
  `chrome-extension://` URLs. Relative paths, `data:`, `about:blank`, `file:`,
  and same-origin URLs stay native.
- `eligible` comes from `GET /browser/status`: the client origin is loopback
  (or absent, i.e. a local CLI caller) **and** the browser is not in `error`
  state. A remote web client over LAN is never eligible and silently falls
  back to the native engine.
- `preferNative` is a per-session override set by the "Use built-in view" link
  on the placeholder pane, for pages that break in real Chrome.

In sidecar mode the renderer does not load the URL into the
WebContentsView at all; it shows a placeholder ("The page is shown in the
Cabinet Browser window") plus, in web mode only, a Cabinet tab strip that
mirrors the sidecar tabs. On desktop, Chromium's own tab strip is the tab UI
and the Cabinet strip is hidden.

## Window sync and focus protocol (Electron)

The Chromium window floats over the browse pane. The renderer computes the
pane rect in screen coordinates (`window-geometry` IPC gives the content
bounds origin) and POSTs `/browser/window/bounds` throttled to ~50 ms on
resize, window move, fullscreen transitions, and engine changes. Position and
size map to CDP `Browser.setWindowBounds` (`left`/`top`).

macOS specifics, which took real debugging:

- This CfT build ignores `windowState: "minimized"` via CDP *and* via Apple
  Events (`set minimized of window`). Hiding uses System Events
  `set visible ... to false`, which lands asynchronously (observed 1-4 s).
- Unhide and frontmost activation go through `open -b <bundleId>`
  (LaunchServices). Apple Events `set visible true` / `activate` are silently
  denied by TCC for non-GUI processes, so the daemon cannot unhide Chromium
  any other way.
- The packaged app declares `NSAppleEventsUsageDescription`; a denied
  Automation prompt degrades gracefully: the window stays visible and the
  renderer raises the Cabinet window over it (`cabinet:focus-app-window`
  IPC, `win.restore()/show()/focus()`), so the pane is covered regardless.
- The unmount/leave-sidecar hide is deferred 400 ms in the renderer so React
  StrictMode remounts cancel it; a late-landing hide was previously observed
  hiding Chromium mid-browse.
- `open -b` caveat: overriding the binary with `CABINET_CHROMIUM_PATH` to
  point at the user's branded Chrome makes `open -b` target *their* Chrome
  (same bundle id class), potentially focusing their personal browser.

Blur never hides the window (blur is what happens when the user clicks into
Chromium). Cabinet minimize sends `visible:false`; restore re-syncs with
`visible:true`. A 150 ms focus protocol hands focus back to Chromium when
Cabinet regains focus in sidecar mode, unless the user is typing or a dialog
is open.

## Data locations

`server/browser/paths.ts`, under `<appdata>/Browser/`:

```
bin/           Chrome for Testing download cache (@puppeteer/browsers)
Profile/       persistent user-data-dir (cookies, login state, extensions)
Extensions/<id> unpacked extension payloads (re-downloaded, never patched)
extensions.json  installed extension records
state.json     last tab set + window bounds (relaunch restore)
```

`<appdata>` is `CABINET_USER_DATA` when set (Electron passes its userData dir,
so the packaged profile lands in `~/Library/Application Support/Cabinet/Browser`;
`scripts/dev-daemon.mjs` derives a default when unset). Otherwise it is
`~/.cabinet/browser`.

## Chromium binary

Pinned build: `PINNED_CHROME_BUILD = "153.0.8010.47"` in
`chromium-manager.ts`, downloaded lazily on first use via
`@puppeteer/browsers` into `bin/` (progress is broadcast on the `browser`
channel). Overrides, in order:

1. `CABINET_CHROMIUM_PATH` env var (full path to a Chrome/Chromium binary)
2. `browser.chromiumPath` in `cabinet-config.json`

Launch flags include `--remote-debugging-pipe`,
`--enable-unsafe-extension-debugging` (required for `Extensions.*` CDP calls),
`--disable-infobars` (suppresses the "Chrome for Testing is only for
automated testing" warning bar), `--no-first-run`, and the persisted tab URLs. Chrome's own session-restore
files (`Profile/Default/Sessions{,_Encrypted}`) are cleared before spawn so a
crash cannot stack duplicate tabs on top of the restored set.

## Extensions

Extensions run unmodified in the real Chrome runtime:

- Install by Web Store ID or URL: the daemon downloads the CRX from the Web
  Store update endpoint
  (`clients2.google.com/service/update2/crx?response=redirect&prodversion=<build>`),
  strips the CRX2/CRX3 header, unzips into `Extensions/<id>` (with a
  path-traversal guard on entry names), and loads it via CDP
  `Extensions.loadUnpacked`. No manifest patching, no stub injection.
- On `chromewebstore.google.com` the `webstore-hook` injected script relabels
  the install button to "Add to Cabinet" and routes clicks through the daemon.
- Enable/disable/pin map to `Extensions.enable/disable` plus a persisted
  `pinned` flag. Disabled extensions stay installed but are not loaded at
  launch.
- Options pages open as `chrome-extension://<runtimeId>/<optionsPage>` tabs.
- **Migration**: on first launch the daemon lazily migrates the legacy
  `extensions[]` records in `cabinet-config.json` (Electron-era installs),
  honoring `enabled`/`pinned`, deletes the old stub-patched unpacked dirs
  under `<userData>/extensions/`, then removes the `extensions` key from the
  config. Migration is one-shot and nonfatal.

## Daemon HTTP API

All routes live under `/browser/` (`server/browser/http.ts`), require the
daemon bearer token, and read the client origin from
`x-cabinet-client-origin` first, then `Origin`. Mutation routes call
`ensureRunning()` first, so they lazily download/launch Chromium.

| Method + path | Body | Response |
|---|---|---|
| `GET /browser/status` | - | `{status, available, eligible, version, executablePath, pid, bundleId, error?, download?}` |
| `POST /browser/launch` | - | `{ok, status}` |
| `POST /browser/shutdown` | - | `{ok, status}` |
| `POST /browser/download` | - | `{ok, status}` |
| `GET /browser/tabs` | - | `{tabs: SidecarTab[]}` |
| `POST /browser/tabs` | `{url}` | `{tab}` |
| `POST /browser/tabs/:id/activate` | - | `{tab}` |
| `POST /browser/tabs/:id/close` | - | `{ok}` (or tab record) |
| `POST /browser/tabs/:id/navigate` | `{url}` | `{tab}` |
| `POST /browser/tabs/:id/back` · `/forward` · `/reload` | - | `{ok}` |
| `POST /browser/tabs/:id/evaluate` | `{expression}` | `{result}` |
| `GET /browser/tabs/:id/extract?html=1` | - | `{url, title, text}` (+`html` when requested) |
| `GET /browser/tabs/:id/screenshot` | - | `image/png` bytes |
| `GET /browser/extensions` | - | `{extensions: SidecarExtension[]}` |
| `POST /browser/extensions` | `{idOrUrl}` (or `{id}`) | `{extension}` |
| `DELETE /browser/extensions/:id` | - | `{ok}` |
| `POST /browser/extensions/:id/enable` · `/disable` | - | `{extension}` |
| `POST /browser/extensions/:id/pin` · `/unpin` | - | `{extension}` |
| `POST /browser/window/bounds` | `{x?, y?, width?, height?, visible?}` | `{ok}` |
| `POST /browser/window/focus` | - | `{ok}` |

Tab URLs are restricted to `http:`, `https:`, `chrome-extension:`, and
`about:blank`. Errors return `{error, code}` with a matching HTTP status.

## `cabinet-browser` CLI

Agents drive the browser through a shim written by the daemon into
`<data-parent>/.cabinet-state/bin/cabinet-browser` (same directory and token
discovery as `cabinet-documents`). Every command prints JSON on stdout; errors
print `{"error":{code,message}}` and exit 1. The tool sends
`x-cabinet-client-origin: http://127.0.0.1` so it is always loopback-eligible.

```
cabinet-browser status
cabinet-browser tabs
cabinet-browser open <url>
cabinet-browser navigate <tabId> <url>
cabinet-browser activate <tabId>
cabinet-browser close <tabId>
cabinet-browser back|forward|reload <tabId>
cabinet-browser eval <tabId> <expression>     # expression "-" reads stdin
cabinet-browser text <tabId>                  # readable text extraction
cabinet-browser html <tabId>                  # raw HTML
cabinet-browser screenshot <tabId> [outPath]  # default /tmp/cabinet-browser-<id>-<ts>.png, prints {path}
cabinet-browser extensions
cabinet-browser install-extension <idOrUrl>
```

Agent prompt guidance (in `conversation-runner.ts`): prefer `text`/`eval`
over screenshots, and do not close tabs you did not open; the tab list is
shared with the user.

## Events

The daemon broadcasts on the `browser` channel (`useDaemonChannel("browser")`
in the renderer; `/api/documents/events` allows the channel):

- `browser:status`: status machine transition (UI refetches `getStatus()`)
- `browser:download`: download progress `{received, total}` (optimistic merge)
- `browser:tab`: tab created/updated/closed
- `browser:extension`: extension installed/uninstalled/enabled/disabled

## Web mode and remote clients

Without the Electron bridge there is no bounds sync and no tab-strip hiding:
the placeholder shows "The Cabinet Browser is open in a separate window" with
a "Show browser" button, and the Cabinet tab strip stays visible because the
free-floating Chromium window needs an in-app controller. Remote clients are
not eligible at all (`eligible:false`, `available:false`), so a LAN browser
never triggers a download and external URLs stay on the iframe/native path.

## Security boundaries

- The daemon bearer token lives only in `<data-dir>/.agents/.runtime/daemon-token`
  and never reaches the renderer; the Next proxy attaches it server-side.
- The proxy forwards the *caller's* origin as `x-cabinet-client-origin`, so a
  remote browser cannot impersonate a loopback client.
- Tab URL allowlist blocks `javascript:`, `file:`, `data:` and friends at the
  daemon, not just the UI.
- CRX unpack skips zip entries that would escape `Extensions/<id>`.
- `Browser.evaluate` results are JSON-shaped; the CLI never echoes the token
  or absolute data-dir paths in error output.

## Troubleshooting

- **Download fails offline**: status stays `missing` with an error; retry via
  `POST /browser/download` or Settings → Extensions → Download once online.
- **User quit Chromium**: a clean exit goes to `stopped` with no relaunch
  (by design); the next sidecar navigation relaunches with the persisted tabs.
- **Crash loop**: auto-relaunch fires at most once per 60 s; repeated crashes
  leave status `stopped`/`error` and the UI falls back to the native engine.
- **Window won't hide on macOS**: the Automation permission prompt for
  System Events was denied (or never shown in dev). Cabinet still raises
  itself over the Chromium window, so the pane looks correct; grant the
  permission in System Settings → Privacy & Security → Automation to get real
  hiding.
- **Chromium hidden and won't come back**: `open -b com.google.chrome.for.testing`
  unhides it; the daemon does this itself on `visible:true`/`focus`.
- **Stale profile**: `Profile/` is a normal Chrome user-data-dir; if Chrome
  reports the profile in use, a leftover `SingletonLock` inside `Profile/`
  can be removed after confirming no Chromium process is alive.
