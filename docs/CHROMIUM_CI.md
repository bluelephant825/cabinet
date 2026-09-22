# Chromium CI — self-hosted runner

GitHub Actions drives the fork build, but the compute is your Mac: Chromium
needs macOS (Xcode, SDK, codesign, `ditto`), ~120 GB disk, and a warm ~30 GB
checkout — no hosted runner qualifies, and neither GCP nor Azure rent Macs.

The workflows live in this repo; the runner executes them on your machine.
GitHub is the remote control — nothing leaves the Mac except the release zip.

## Workflows

| Workflow | Trigger | What it does |
|---|---|---|
| `chromium-update-check` | Weekly cron + manual | Compares `CHROMIUM_VERSION` (in `~/Developer/cabinet-chromium`) against the latest stable tag via the versionhistory API; opens a GitHub issue when behind (dedupes on title). |
| `chromium-release` | Manual only | `fetch.sh` → `apply-patches.sh` → `build.sh release` → `npm ci` → `release-chromium-app.mjs --skip-build` → draft GitHub release. On a `git am` conflict it opens an issue and stops. |

Both declare `runs-on: [self-hosted, macOS, ARM64]` — GitHub auto-applies
those labels to a Mac runner, so no custom labels are needed.

## One-time runner setup

1. Repo → **Settings → Actions → Runners → New self-hosted runner → macOS → ARM64**.
   GitHub shows a download URL + token. On the Mac:

   ```sh
   mkdir ~/actions-runner && cd ~/actions-runner
   curl -o runner.tar.gz -L <download-url-from-GitHub>
   tar xzf runner.tar.gz
   ./config.sh --url https://github.com/bluelephant825/cabinet --token <token>
   ./svc.sh install && ./svc.sh start   # launchd service — survives logout/reboot
   ```

2. Verify it shows **Idle** under Settings → Actions → Runners.

### Runner prerequisites (already true on the dev machine)

- Xcode + accepted license + the pinned `MacOSX26.5.sdk`
- `~/depot_tools`, warm `~/chromium` checkout, `~/Developer/cabinet-chromium`
- node/npm, `gh` — the workflows inject `GH_TOKEN` from `secrets.GITHUB_TOKEN`,
  so `gh auth login` on the machine is not strictly required
- If your paths differ, edit the two `env:` vars at the top of each workflow
  (`CABINET_CHROMIUM_SRC`, `CABINET_CHROMIUM_TOOLING`)

### Security note

Self-hosted runners execute whatever a workflow asks, as your user. Fine here —
private repo, you are the only contributor. Never attach this runner to a
public repo or one with outside contributors; fork PRs could run arbitrary
code on your Mac.

## Using it

- **Weekly**: the update check files an issue when stable moves past the pin.
- **Release**: Actions → *Chromium release* → Run workflow → optional
  `chromium_version` override, optional `publish`. ~hours on first cold run;
  the warm checkout makes later runs much faster. Ends in a draft release —
  review on GitHub, publish when happy.

`cabinet-chromium` itself stays local (the workflows call its scripts by
path). Pushing it to a private repo is still worthwhile as a backup of the
patch stack — but nothing in CI requires it.
