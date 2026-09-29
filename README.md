<p align="center">
  <img src="assets/cabinet-wordmark.svg" alt="cabinet /ˈkab.ɪ.nət/" width="920">
</p>

<p align="center">
  <img src="https://runcabinet.com/demo.gif" alt="Cabinet demo" width="900">
</p>

<h1 align="center">🗄️ Cabinet</h1>

<p align="center">
  <strong>Your knowledge base. Your AI team.</strong><br />
  <sub>🗂️ Files on disk &nbsp;•&nbsp; 📁 AI workspaces &nbsp;•&nbsp; 🧠 Agents with memory</sub>
</p>

<p align="center">
  The AI-first startup OS where everything lives as markdown files on disk. No database. No vendor lock-in. Self-hosted. Your data never leaves your machine.
</p>

<p align="center">
  Original build by Hila Shmuel, former Engineering Manager at Apple — now building Cabinet in public, with the open-source community.
</p>

<p align="center">
  <a href="https://x.com/HilaShmuel" target="_blank" rel="noopener noreferrer">@HilaShmuel</a>&nbsp; • &nbsp;
  <a href="https://runcabinet.com" target="_blank" rel="noopener noreferrer">runcabinet.com</a>&nbsp; • &nbsp;
  <a href="mailto:hi@runcabinet.com" target="_blank" rel="noopener noreferrer">hi@runcabinet.com</a>
</p>

<p align="center">
  <a href="https://github.com/cabinetai/cabinet/stargazers" target="_blank" rel="noopener noreferrer">
    <img src="https://img.shields.io/github/stars/cabinetai/cabinet?style=for-the-badge&logo=github&logoColor=white&label=Star%20the%20vision%20%F0%9F%98%8D%F0%9F%8C%9F&labelColor=4b4b4b&color=f5b301" alt="Star Cabinet on GitHub" valign="middle">
  </a>&nbsp;
  <a href="https://discord.gg/hJa5TRTbTH" target="_blank" rel="noopener noreferrer">
    <img src="https://img.shields.io/badge/Discord-Join%20the%20community-5865F2?style=for-the-badge&logo=discord&logoColor=white&labelColor=4b4b4b" alt="Join the Discord" valign="middle">
  </a>&nbsp;
  <a href="https://runcabinet.com/waitlist" target="_blank" rel="noopener noreferrer">
    <img src="https://img.shields.io/badge/%F0%9F%97%84%EF%B8%8F%20Cabinet-Cloud%20Waitlist-55c938?style=for-the-badge&labelColor=4b4b4b" alt="Cabinet Cloud Waitlist" valign="middle">
  </a>&nbsp;
  <a href="https://coderabbit.ai" target="_blank" rel="noopener noreferrer">
    <img src="https://img.shields.io/coderabbit/prs/github/cabinetai/cabinet?utm_source=oss&utm_medium=github&utm_campaign=cabinetai%2Fcabinet&labelColor=171717&color=FF570A&link=https%3A%2F%2Fcoderabbit.ai&label=CodeRabbit+Reviews" alt="CodeRabbit Pull Request Reviews" valign="middle">
  </a>
</p>

---

## From zero to AI team in 2 minutes

```bash
npx create-cabinet@latest
```

This creates a Cabinet workspace and starts the packaged app. For source development, run `npm run dev:all` from a Cabinet source checkout.

---

## Install, update, uninstall

Cabinet runs entirely through `npx` — no global install needed. The CLI is the [`cabinetai`](https://www.npmjs.com/package/cabinetai) package; `create-cabinet` is a thin wrapper around it.

### Install / create

```bash
npx create-cabinet@latest          # create a cabinet and start it
npx cabinetai create my-startup    # just create, don't start
npx cabinetai run                  # start Cabinet in the current dir
```

On first run, Cabinet downloads the prebuilt app bundle to `~/.cabinet/app/v{version}/`. Your cabinet directory is just a folder of markdown files — put it anywhere.

### Update

```bash
npx cabinetai update               # check for and install a newer app version
```

The CLI compares your installed app version against `cabinet-release.json` from the latest GitHub Release.

### Uninstall / remove

```bash
npx cabinetai uninstall            # remove cached app versions only
npx cabinetai uninstall --all      # also remove global state + telemetry data
npx cabinetai uninstall --yes      # skip the confirmation prompt
npx cabinetai remove               # alias for uninstall
```

The command prints a summary of what will be deleted and asks for confirmation before doing anything. **Your cabinet directories and their data are never touched — those you'd delete manually.**

`--all` additionally removes the platform-specific telemetry directory:

- macOS: `~/Library/Application Support/cabinet-telemetry/`
- Windows: `%APPDATA%\cabinet-telemetry\`
- Linux: `$XDG_CONFIG_HOME/cabinet/` (falls back to `~/.config/cabinet/`)

To wipe Cabinet completely, run `uninstall --all` and then `rm -rf` your cabinet directories yourself.

See [docs/CABINETAI.md](docs/CABINETAI.md) for the full CLI reference.

---

## The problem

Every time you start a new Claude session, it forgets everything. Your project context, your decisions, your research — gone. Scattered docs in Notion. AI sessions with no memory. Manual copy-paste between tools.

## The solution

One knowledge base. AI agents that remember everything. Scheduled jobs that compound. Your team grows while you sleep.

> If it feels like enterprise workflow software, it's wrong. If it feels like watching a team work, it's right.

---

## Philosophy

Cabinet is built around a few principles that we think matter deeply for the future of AI + data tools:

- **Yours** — Your data stays yours: local, visible, and portable. It’s not trapped inside a particular AI provider’s system with no clean way to get it out. You stay in control of your information.
- **Git everything** — Memory should have history. You should be able to inspect changes, revert mistakes, audit how knowledge evolves, and treat your AI system like the important infrastructure it is.
- **BYOAI** — Bring your own AI. Cabinet should work with Claude, Codex, OpenCode, local models, and whatever comes next, without forcing your knowledge into a single provider’s ecosystem.
- **KISS** — Keep it simple, stupid. AI tools should be understandable, inspectable, and hackable. We prefer plain files, clear behavior, and systems that developers can actually reason about.
- **Security** — We care deeply about security. If AI is going to work with your documents, research, plans, and internal context, the system should minimize surprise, reduce unnecessary exposure, and make trust a design requirement rather than an afterthought.
- **Self-hosted** — If AI is going to hold your context, plans, research, and operating memory, it should run in an environment you control.

## Everything you need. Nothing you don't.

| Feature | What it does |
|---|---|
| **WYSIWYG + Markdown** | Rich text editing with Tiptap, tables, code blocks, frontmatter, and slash commands. |
| **Documents and Notebooks** | View and edit common office documents, PDFs, Markdown, and Jupyter notebooks. See the format guide below for capabilities and optional tools. |
| **Diagrams, Charts, and 3D** | Create Draw.io and Excalidraw diagrams, preview Mermaid, insert bar, line, and pie charts or live code blocks from the editor slash menu, and view `.glb`/`.gltf` models. |
| **Canvas** | View pages, folders, and supported documents as movable, resizable preview cards on a zoomable board. |
| **LLM Wiki** | Opt in from Settings to build linked Wiki pages from selected notes with a configured AI agent, while keeping the originals editable. Inspect sources, track processing, and explore the generated knowledge graph. |
| **Built-in Chromium Browser** | Use daemon-managed Chromium from local loopback source-mode clients or the macOS Chromium desktop host. Install supported Chrome extensions from the Chrome Web Store or an unpacked folder. Remote LAN clients are ineligible, and extension compatibility varies. |
| **AI Agents** | Local provider adapters run tasks, jobs, and heartbeats with persisted conversations and memory. |
| **Skills** | Browse and install from skills.sh or GitHub. Attach skills to agents, or `@`-mention one for a single task. |
| **Scheduled Jobs** | Cron-based agent automation for recurring research, reports, and other work. |
| **PDF Composition** | Build and render structured PDF documents from reusable components. |
| **Embedded HTML Apps** | Drop an `index.html` in a folder to render it as an app, with full-screen mode. |
| **Google and Local Knowledge** | Link Google Workspace pages or mount local synced knowledge sources into the file tree. |
| **Web Terminal** | Interactive local AI CLI terminal for direct sessions and debugging. |
| **File-Based Everything** | No database. Content stays in ordinary files on disk and remains portable. |
| **Git-Backed History** | Auto-committed changes, diffs, and page restoration. |
| **Missions, Tasks, and Chat** | Track work on Kanban boards and communicate in built-in team channels. |
| **Full-Text Search** | Cmd+K search across pages with fuzzy matching. |
| **Dark/Light Mode** | Theme toggle with dark mode by default. |

## Document, diagram, and media support

Cabinet opens many formats directly from the file tree. Editing and execution capabilities depend on the format:

| Files | Built-in support | Optional tool or limitation |
|---|---|---|
| `.md` | Rich Markdown editing, frontmatter, tables, and code blocks. | None. |
| `.mdx` | Opens in the source viewer. | Markdown rendering supports only Cabinet's verified components, not arbitrary MDX execution. |
| `.pdf` | PDF viewing and document-service editing. | The read-only viewer remains available when editing is unavailable. |
| `.docx` | Document-service editing and preview. | A read-only preview is used when editing is unavailable. |
| `.xlsx`, `.xlsm`, `.pptx` | Inline spreadsheet and presentation viewers. | Read-only. Legacy `.doc`, `.xls`, and `.ppt` files use the fallback viewer. |
| `.csv` | Inline spreadsheet viewer. | None. |
| `.ipynb` | Open notebooks, edit cells, and keep saved outputs. | Cell execution needs a running local Jupyter server and a matching installed kernel. |
| `.mmd`, `.mermaid` | Mermaid diagram preview. | None. |
| `.drawio`, `.dio`, `.drawio.svg` | Open and edit local Draw.io diagrams. | None. |
| `.excalidraw`, `.excalidraw.svg` | Open and edit local Excalidraw drawings. | None. |
| `.tex`, `.latex` | LaTeX source and built-in preview. | No TeX distribution is required for the preview. |
| `.typ` | Typst source view. | PDF preview requires the native Typst CLI. |
| `.glb`, `.gltf` | Interactive 3D model viewer. The same viewer is available through the verified `ModelViewer` Markdown component. | None. |
| Images, audio, video, and source files | Built-in image, media, and code viewers. | None. |

In a Markdown editor, typing `/draw` filters the slash menu to **Draw.io Diagram**. Typing `/excalidraw` filters it to **Excalidraw Drawing**. Choose the menu item to insert an editable local diagram or drawing. These are editor commands, not shell commands.

The verified MDX component registry includes `Callout`, `VideoPlayer`, `ModelViewer`, `NotebookCell`, `CodeOutput`, `DataFrame`, `PlotlyChart`, `ImageOutput`, and `ErrorOutput`. Cabinet does not execute arbitrary MDX.

---

## Ship HTML apps inside your knowledge base

This is the biggest difference between Cabinet and tools like Obsidian or Notion. Drop an `index.html` in any directory — it renders as an embedded app. Full-screen mode with sidebar auto-collapse. AI-generated apps written directly into your KB. Version controlled via git. No build step.

---

## Not another note-taking app

| Feature | Cabinet | Obsidian | Notion |
|---|---|---|---|
| AI agent orchestration | Yes | No | No |
| Scheduled cron jobs | Yes | No | No |
| Embedded HTML apps | Yes | No | No |
| Web terminal | Yes | No | No |
| Self-hosted, files on disk | Yes | Yes | No |
| No database / no lock-in | Yes | Yes | No |
| Git-backed version history | Yes | Via plugin | No |
| WYSIWYG + Markdown | Yes | Yes | Yes |

---

## Hire your AI team in 5 questions

Cabinet ships with 20 pre-built agent templates. Each has a role, recurring jobs, recommended skills, and a workspace in the knowledge base.

| Department | Agents |
|---|---|
| **Leadership** | CEO, COO, CFO, CTO |
| **Product** | Product Manager, UX Designer |
| **Marketing** | Content Marketer, SEO Specialist, Social Media, Growth Marketer, Copywriter |
| **Engineering** | Editor, QA Agent, DevOps Engineer |
| **Sales & Support** | Sales Agent, Customer Success |
| **Analytics** | Data Analyst |
| **Operations** | People Ops, Legal Advisor, Researcher |

---

## How it works

1. **Install & Run** — One command. Next.js + daemon start.
2. **Answer 5 Questions** — Cabinet builds your custom AI team.
3. **Watch Your Team Work** — Agents create missions, write content, scout Reddit, file reports.
4. **Knowledge Compounds** — Every agent run, every edit adds to the KB. Context builds over time.

---

## AI Runtime Today

Cabinet no longer treats the browser terminal as the only way to run AI work.

- **Tasks, jobs, and heartbeats** now run through a provider adapter layer with persisted conversations and transcript-driven live views.
- **Per-run overrides** can choose provider, model, and reasoning effort, while personas and jobs can still inherit defaults.
- **Current defaults** are structured local adapters: `claude_local` for Claude Code and `codex_local` for Codex CLI.
- **The web terminal is staying** as a first-class interactive surface for direct CLI sessions and future terminal-native features such as Cabinet-managed tmux-like workspaces.

---

## Architecture

```
cabinet/
  src/
    app/api/         -> Next.js API routes
    components/      -> React components (sidebar, editor, agents, jobs, terminal)
    stores/          -> Zustand state management
    lib/             -> Storage, markdown, git, agents, jobs
  server/
    cabinet-daemon.ts -> WebSocket + job scheduler + structured adapters + agent executor
    pty/              -> PTY session module (spawn, Claude lifecycle, ansi)
  data/
    .agents/.library/ -> 20 pre-built agent templates
    getting-started/  -> Default KB page
```

**Tech stack:** Next.js 16, TypeScript, Tailwind CSS, shadcn/ui, Tiptap, Monaco Editor, Zustand, xterm.js, node-cron

---

## Requirements

### Base requirements

- **Node.js 22+ (LTS)** for source development and the `npx` CLI. The repo ships an `.nvmrc`; run `nvm use` in the source checkout. The installed prebuilt app bundles its runtime and does not need a separate Node installation.
- **AI provider CLI for agent runs.** Install at least one supported local provider to run agents, tasks, jobs, and heartbeats. Examples include Claude Code (`npm install -g @anthropic-ai/claude-code`) and Codex CLI (`npm install -g @openai/codex`). Cabinet can also use other supported local adapters.
- **Source mode:** macOS, Linux, or Windows.
- **Packaged desktop:** the Chromium-hosted desktop build currently targets macOS. Windows Electron packaging is legacy and should not be assumed to provide the same host features.

### Optional local tools

- **Typst PDF preview:** `.typ` source files open without Typst installed. To compile them for PDF preview, install the native CLI. On macOS with Homebrew:

  ```bash
  brew install typst
  typst --version
  ```

- **Jupyter notebook execution:** `.ipynb` files can be viewed and edited, including saved outputs, without Python or Jupyter. To run cells, install JupyterLab and a Python kernel in a virtual environment, then start Jupyter in another terminal while Cabinet is running:

  ```bash
  python3 -m venv ~/cabinet-jupyter-venv
  source ~/cabinet-jupyter-venv/bin/activate
  python -m pip install jupyterlab ipykernel
  python -m jupyter lab --no-browser
  ```

  Cabinet discovers a local Jupyter server from its runtime files. The notebook's kernelspec name must match a kernel installed in that Jupyter environment.

LaTeX preview for `.tex` and `.latex` files is built in and does not require a TeX distribution.

## Configuration

```bash
cp .env.example .env.local
```

| Variable | Default | Description |
|----------|---------|-------------|
| `KB_PASSWORD` | _(empty)_ | Password to protect the UI. Leave empty for no auth. The auth cookie is PBKDF2(password, per-install salt) with login rate-limiting; changing the password logs everyone out once. |
| `CABINET_AUTH_SALT` | _(auto)_ | Per-install auth salt, auto-generated into `.cabinet.env` on first run. Set only to pin a value; changing it forces a one-time re-login. |
| `CABINET_LOGIN_PBKDF2_ITERS` | `600000` | PBKDF2 iteration count for the auth token. Lower only for constrained hardware. |
| `CABINET_LOGIN_MAX_ATTEMPTS` / `_WINDOW_MS` / `_LOCKOUT_MS` / `CABINET_LOGIN_GLOBAL_MAX` | `10` / `900000` / `900000` / `60` | Login rate-limit tuning (per-client + global failed-attempt buckets). |
| `DOMAIN` | `localhost` | Domain for the app. |

### Authentication

Setting `KB_PASSWORD` turns on a single password gate for the whole UI/API
(leave it empty for no auth). The session cookie is `PBKDF2-HMAC-SHA256` over a
per-install salt that's auto-generated into `.cabinet.env` on first run, the
login endpoint is rate-limited against brute force, and the gate verifies in
constant time. Changing the password (or salt/iterations) logs everyone out
once. Full details, threat model, and tuning: **[docs/AUTH.md](docs/AUTH.md)**.

## Commands

```bash
npm run dev          # Next.js development server (port 4000 by default)
npm run dev:daemon   # Local daemon (port 4100 by default)
npm run dev:all      # Start both source-mode servers
npm run build        # Production build
npm run start        # Run both production servers
npx cabinetai run    # Download and start the packaged runtime
```

The Chromium-hosted desktop app currently targets macOS. Source-mode development also supports Linux and Windows. The Windows Electron packaging script is retained for legacy use.

---

## Ready to build your AI team?

Cabinet is free, open source, and self-hosted. Your data never leaves your machine.

```bash
npx create-cabinet my-startup
```

[Get Started](https://runcabinet.com) | <a href="https://github.com/cabinetai/cabinet/stargazers" target="_blank" rel="noopener noreferrer"><img src="https://img.shields.io/github/stars/cabinetai/cabinet?label=GitHub%20Stars&logo=github&color=f5b301" alt="GitHub Stars" valign="middle"></a>

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for breaking changes, or follow the full release history on the [documentation site](https://runcabinet.com).

## Privacy

Cabinet sends anonymous usage telemetry by default (event counts, versions,
platform — never file contents, paths, prompts, or secrets).

To turn it off, pick one:

```bash
export CABINET_TELEMETRY_DISABLED=1   # env var (any shell session)
```

…or open **Settings → Privacy** and toggle **Send anonymous usage telemetry**
off. To also wipe the local install ID and queue, run
`npx cabinetai uninstall --all`.

See [TELEMETRY.md](TELEMETRY.md) for the full event list, payload schema,
and where data is stored.

## Community

Questions, ideas, feedback, screenshots, wild experiments — bring them to the [Discord](https://discord.gg/hJa5TRTbTH). That’s where the Cabinet community hangs out and where a lot of the product direction gets shaped in real time.

---

## Contributing

Cabinet is moving fast right now. We’d love thoughtful contributors who want to help shape it early.

If you’re thinking about opening a PR, please start by joining the [Discord](https://discord.gg/hJa5TRTbTH) and talking with Hila before coding. Hila is Cabinet’s builder, and that early sync helps us keep the roadmap coherent while the product is still evolving rapidly.

Once the direction is aligned, open your PR on [GitHub](https://github.com/cabinetai/cabinet). The goal is not gatekeeping — it’s making sure your energy goes into work that has a clear path to landing and shipping.

---

MIT License

---

## Star History

<a href="https://www.star-history.com/?repos=cabinetai%2Fcabinet&type=date&legend=top-left" target="_blank" rel="noopener noreferrer">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=cabinetai/cabinet&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=cabinetai/cabinet&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=cabinetai/cabinet&type=date&legend=top-left" />
 </picture>
</a>
