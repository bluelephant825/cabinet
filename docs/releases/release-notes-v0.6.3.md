## Cabinet v0.6.3 — Chromium-hosted build (macOS arm64)

Draft preview build for the staged GenOffice document upgrade. The React/Next.js Cabinet shell is hosted inside the Cabinet Chromium fork — real tabs, real MV3 extensions, browser profiles, all inside one window. No Electron runtime is used for this app package.

### Highlights

- DOCX editing adds find and replace, comments, tracked changes, horizontal rules, image insertion, headers/footers, styles, and table properties.
- XLSX files open in an editable Univer-based spreadsheet with revision-safe saves through Cabinet document service.
- PPTX files support high-fidelity viewing plus text-run and speaker-notes editing.
- The guarded GenOffice agent skill supports approved XLSX/PPTX operations while Cabinet remains authoritative for DOCX/PDF writes.
- A host-shell watchdog detects a stalled blank Chromium `browser_ui`, reloads it, and relaunches Chromium as a rate-limited fallback.

### Install

1. Download **Cabinet-0.6.3-macos-arm64.zip**, unzip, and move **Cabinet.app** to /Applications.
2. This build is ad-hoc signed (not notarized yet), so macOS will report it "damaged" until you strip the quarantine attribute — right-click → Open does **not** work for unsigned apps. Run:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Cabinet.app
   ```

3. Launch normally. Quitting the browser window exits the whole app.

### Notes

- Chromium 153.0.8010.47 · Cabinet 0.6.3
- macOS arm64 only for now.
- Draft target: `main` (`0a6a6b7f`).
- SHA-256: `acf9ea3c3e277472325655300987a89e435c891e6ae73a61641fb9901646dce8`
