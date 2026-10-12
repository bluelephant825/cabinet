## Cabinet v0.6.4 - Chromium-hosted build (macOS arm64)

The React/Next.js Cabinet shell is hosted inside the Cabinet Chromium fork with real tabs, real MV3 extensions, browser profiles, and one desktop window. No Electron runtime is used for this app package.

### Highlights

- Agent Browser Automation is opt-in from Settings. Cabinet installs the pinned AlohaJet v0.4.4 actuator and exposes structured browsing tools through run-local MCP or `cabinet-browser`.
- Agents can inspect structural page Markdown, manage tabs, click, type, select, navigate, press keys, wait, and read text in Cabinet's shared Chromium browser.
- Cabinet-native imports can download public PDFs and supported documents, save passive Markdown page snapshots, and optionally convert imported PDFs to Markdown.
- A private capability-gated CDP bridge keeps Chromium's debugging pipe internal, protects pre-existing user tabs, applies run-scoped sessions, and rejects non-loopback automation clients.
- Public downloads include redirect and DNS validation, private-address rejection, size and time limits, signature checks, collision-safe writes, provenance, and history/tree updates.
- Managed browser automation installs are available on macOS and Linux x86_64. Windows and Linux ARM remain unsupported for managed installation.
- If macOS blocks the checksum-verified AlohaJet executable on first launch, Cabinet preserves it so it can be approved in System Settings > Privacy & Security and retried.
- Browse mode restores only Cabinet's saved tabs from the immediately previous session.
- Task sidebar conversations survive Focus mode, and the sidebar menu now includes Clear chat.
- Agent-facing browser answers summarize results without exposing raw commands, structural snapshots, tab IDs, element IDs, or JSON in the chat response.
- Conversation UI classes were canonicalized for Tailwind CSS 4 without changing the intended layout.

### Install

1. Download **Cabinet-0.6.4-macos-arm64.zip**, unzip, and move **Cabinet.app** to `/Applications`.
2. This build is ad-hoc signed (not notarized yet), so macOS will report it "damaged" until you strip the quarantine attribute. Right-click -> Open does not work for unsigned apps. Run:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Cabinet.app
   ```

3. Launch normally. Quitting the browser window exits the whole app.

### Notes

- Chromium 153.0.8010.47 · Cabinet 0.6.4
- macOS arm64 only for now.
- Draft target: `main` (`2910a20f`).
- SHA-256: `d0b2d58a5c26b313a484c8a2d6c5d0ce76c542cda27612df8eb8823b216c9ebd`
- The zip extracts a single top-level `Cabinet.app`.
