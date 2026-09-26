# tGD Pi Web

<p align="center">
  <a href="https://github.com/yhwangtw/tgd-pi-web/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/yhwangtw/tgd-pi-web/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16-000000?style=flat-square&logo=nextdotjs">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-149ECA?style=flat-square&logo=react">
</p>

<p align="center">
  <a href="README.md"><strong>English</strong></a> |
  <a href="README.zh-TW.md">繁體中文</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.de.md">Deutsch</a>
</p>

<p align="center">
  <a href="https://github.com/yhwangtw/tgd-pi-web/releases">Releases</a> ·
  <a href="https://github.com/yhwangtw/tgd-pi-web/issues">Report a bug</a> ·
  <a href="https://github.com/yhwangtw/tgd-pi-web/issues">Request a feature</a>
</p>

**A browser workspace for Pi Coding Agent and the complete tGD delivery workflow.**

tGD Pi Web turns Pi's local sessions into a visual engineering cockpit: chat with the agent in real time, inspect files and git changes, move between branches, restore snapshots, and follow work from Map through Release without leaving the browser.

![tGD Pi Web chat interface](./docs/screenshots/02-hero-chat.png)

## Why tGD Pi Web?

Pi's terminal experience is fast and focused. This project adds the visual context needed for longer or parallel work:

- See live output, run state, elapsed time, errors, queued messages, and context pressure.
- Browse every local Pi session without starting an agent process.
- Review files, diffs, tool calls, and git changes beside the conversation.
- Track tGD artifacts and the seven delivery phases in the same workspace.
- Navigate long conversations with search, bookmarks, a minimap, and branches.
- Work comfortably on phones and desktops with safe-area-aware navigation, a compact pipeline, and touch-friendly message actions.
- Keep execution local-first: external traffic is limited to configured model/MCP endpoints and the optional latest-version check shown in Runtime settings.

## Who is this for?

- Developers already using [Pi Coding Agent](https://github.com/earendil-works/pi).
- Teams following the tGD workflow and storing artifacts in a sibling `<project>-tGD/` directory.
- Engineers who want a browser-based review surface while the agent works locally.
- Offline or enterprise environments using an internal model gateway and npm registry.

## Quick Start

### Requirements

- Node.js 22.19+ on the 22.x line, or 23.4+ (including 24 and newer). This meets the bundled Pi runtime minimum and provides the built-in SQLite file lock without an extra flag.
- npm
- Model credentials/configuration in `~/.pi/agent/` or supported provider environment variables; a global `pi` CLI is not required
- Git

This project is distributed from GitHub source and is **not published to npm**.

> [!IMPORTANT]
> tGD Pi Web can read and edit files, inspect git repositories, and run shell commands in allowed workspaces. Keep it on localhost by default. For remote access, set `PIWEB_ACCESS_PASSWORD` and `PIWEB_SESSION_SECRET`, then place the service behind an authenticated private network or access proxy. See the [deployment guide](./deploy/README.md).

Like Pi CLI, the embedded agent executes tools without a built-in per-action approval gate or five-minute grants. Tools and extensions run with the server account's permissions, including access outside the project; Pi Web is **not** an operating-system sandbox. Only expose the service to trusted users, and use a dedicated OS account, container, or VM when stronger isolation is required. Login protection and the file/Git API workspace boundaries remain enforced. Agent questions and extension confirmations appear as deferrable cards in the conversation, never as blocking popups; deferring a card does not answer or approve it.

Use a dedicated checkout for the supported one-step installation:

```bash
git clone https://github.com/yhwangtw/tgd-pi-web.git
cd tGD-pi-web
bash setup.sh
```

The setup script checks Node.js/npm and refuses a running checkout before any source changes. In a stopped Git checkout it fetches `origin/main`, checks local changes before synchronizing, installs dependencies, validates TypeScript, builds, and can start the production server. Source archives move known obsolete files to `~/.tgd-pi-web-backups/` (override with `TGD_SETUP_BACKUP_DIR`). The Web uses its pinned local Pi runtime; interactive setup can synchronize a different global CLI, while unattended setup only prints the opt-in command.

> [!WARNING]
> Stop the server using this checkout before setup/build. `origin/main` is authoritative for end-user Git installations. If local commits or non-ignored changes exist, setup creates a private recovery backup and asks before replacing source; unattended setup stops unless `TGD_SETUP_FORCE_SYNC=1` explicitly authorizes it. Approved synchronization uses `git reset --hard origin/main` and `git clean -fd`. Ignored runtime state is retained but is not part of this source backup. See [update and rollback boundaries](./docs/RELEASING.md#installation-updates-and-rollback-are-separate).

Manual setup:

```bash
npm install
npm run build
npm start
```

Open [http://localhost:30141](http://localhost:30141).

### Update an existing checkout

This version pins the embedded Pi runtime (`pi-ai` and `pi-coding-agent`) to **0.86.0**. Updating Web installs its own runtime; a globally installed CLI is managed separately. To align an optional global CLI, run `npm install -g @earendil-works/pi-coding-agent@0.86.0` and verify it with `pi --version`.

Pi 0.86 records system-prompt and tool-set changes in the session transcript. Web preserves that state in Pi's session file, keeps system updates out of chat messages and message counts, and retains the correct entry mapping for compacted history, branching, and edit-and-rerun. Custom provider integrations should review the [upstream 0.86 migration notes](https://github.com/earendil-works/pi/releases/tag/v0.86.0).

```bash
bash setup.sh
```

`setup.sh` stops immediately and prints the complete TypeScript error when validation fails. It never continues into a misleading partial build.

Browser-managed updates require an operator-provided staged adapter and loopback identity check. Durable operations verify the actual running build; a helper PID is not success. See [managed updates and rollback](./docs/MANAGED-UPDATES.md). No launchd/systemd adapter is installed automatically.

For a deliberately offline Git checkout, skip remote synchronization explicitly:

```bash
TGD_SETUP_OFFLINE=1 bash setup.sh
```

This skips Git synchronization only; npm still needs an internal registry or
prepared cache. `origin/main` may be newer than the last release. Use a release
source archive in a new directory when you need an exact released version.

## tGD Workflow in the Browser

The phase bar remains visible above the active session:

```text
Map → Define → Plan → Develop → Verify → Review → Release
```

- **Artifact-backed status** — Map, Define, and Plan are completed from real files on disk, not optimistic UI state.
- **Feature-aware progress** — the bar follows the feature named in the latest `/tgd-*` command, or the most recently updated feature.
- **Artifact explorer** — browse curated phase documents or the complete sibling tGD directory, including scans, wiki pages, and prototypes.
- **Prompt-first phase actions** — clicking a phase places the matching command in the composer so you can review it before sending.
- **Git restore points** — the server captures a git-backed snapshot before each run without touching your index or `HEAD`.

Expected artifact layout:

```text
parent/
├── your-project/
└── your-project-tGD/
    ├── CONTEXT.md
    ├── TRACKING-PLAN.md
    ├── CHANGELOG.md
    ├── REGRESSION-CATALOG.md
    ├── wiki/
    └── feature-name/
        ├── PRD.md
        ├── SPEC.md
        ├── DESIGN.md
        ├── TASKS.md
        ├── TEST-REPORT.md
        ├── REVIEW.md
        ├── METRICS.md
        └── prototype/
```

Set `TGD_DIR` when your artifact directory lives elsewhere.

## Interface Tour

<p align="center">
  <img src="./docs/screenshots/11-mobile-chat.png" alt="Responsive mobile conversation view" width="390">
</p>

The mobile layout keeps the active phase, transcript, composer, model controls, and primary navigation within thumb reach while respecting device safe areas.

| Session and file workspace | Command palette |
|---|---|
| ![Code session](./docs/screenshots/03-code-session.png) | ![Command palette](./docs/screenshots/04-command-palette.png) |

| Dark mode | Empty state |
|---|---|
| ![Dark mode](./docs/screenshots/10-dark-mode.png) | ![Empty state](./docs/screenshots/01-empty-state.png) |

<details>
<summary><strong>View all five appearance skins</strong></summary>

| Editorial | Terminal | Aurora |
|---|---|---|
| ![Editorial skin](./docs/screenshots/05-skin-editorial.png) | ![Terminal skin](./docs/screenshots/06-skin-terminal.png) | ![Aurora skin](./docs/screenshots/07-skin-aurora.png) |

| Industrial | Glass |
|---|---|
| ![Industrial skin](./docs/screenshots/08-skin-industrial.png) | ![Glass skin](./docs/screenshots/09-skin-glass.png) |

</details>

## Key Features

<!-- capability-table:start -->
This table is generated from `lib/capabilities.json`; it is the product contract for Web support and runtime dependencies.

| Capability | Foundation | Web delivery | Global Pi CLI | Always-on server | Trust boundary |
| --- | --- | --- | --- | --- | --- |
| **Agent chat** | Official Pi SDK | Native | Not required | Normal Web runtime | Single-user host |
| **Sessions and cross-project search** | Official Pi SDK | Web adapter | Not required | Normal Web runtime | Single-user host |
| **Ask User and inline extension questions** | Official Extension API | Web adapter | Not required | Normal Web runtime | Explicit confirmation |
| **Plan Mode** | Official Extension API | Web adapter | Not required | Normal Web runtime | Trusted workspace |
| **Goal Mode** | Official Extension API | Web adapter | Not required | Required | Trusted workspace |
| **Structured Output** | Official Extension API | Web adapter | Not required | Normal Web runtime | None |
| **Embedded subagents** | Official Pi SDK | Web adapter | Not required | Normal Web runtime | Trusted workspace |
| **MCP connections** | Official Extension API | Web adapter | Not required | Normal Web runtime | Trusted endpoint/command |
| **Scheduled agents** | Official Pi SDK | Web adapter | Not required | Required | Operator configuration |
| **Files, Git, and restore points** | Pi Web | Native | Not required | Normal Web runtime | Trusted workspace |
| **Extensions and packages** | Official package format | Web adapter | Not required | Normal Web runtime | Explicit confirmation |
| **Runtime and security diagnostics** | Pi Web | Native | Not required | Normal Web runtime | Operator configuration |
| **Safe Update Center** | Pi Web | Native | Not required | Required | Operator configuration |
<!-- capability-table:end -->

### Agent chat

Subagent, Plan, and Goal are Pi Web-maintained extensions built on the official Pi SDK and Extension API. They are Web integrations, not unmodified upstream extension packages; Pi SDK upgrades still require compatibility validation here.

- Live SSE streaming with connect-before-prompt delivery.
- Prompt, steer, follow-up queue, retry, bash, and context compaction.
- Direct shell mode with `!command`; use `!!command` to omit the result from model context.
- Model and thinking-level switching during a session.
- Tool access can inherit Pi/project defaults, use a preset, or select individual built-in, extension, and MCP tools.
- A first-party `subagent` tool is installed with the Web runtime: delegate work in separate sessions to the built-in scout, planner, worker, and reviewer, run up to eight tasks through the existing Agent queue, and inspect or cancel every child session from the Agent dashboard. `tasks` runs independent children in parallel, including workers; the Agent panel's shared concurrency limit controls how many run at once (default 3, configurable from 1 to 8). Children share the parent's working directory, so assign workers disjoint files and use `chain` for dependencies such as reviewing a preceding worker's edits. The three read-only built-ins have no shell access. Use **Inherit** or explicitly enable `subagent` in custom tools; explicit core-tool presets do not include it. No global `pi` CLI is required.
- **Goal:** `/goal <objective>` starts a session-owned objective; `/goal --tokens 100k <objective>` adds an optional budget. The Goal panel and `/goal pause`, `/goal resume`, `/goal status`, `/goal budget 200k`, and `/goal clear` manage it. Continuations run only after Pi fully settles, stay hidden in the transcript, and stop on completion, a blocker, model error, user stop, budget exhaustion, three repeated/empty tool-free responses. There is no fixed continuation cap; use `/goal --runs 50 <objective>` or `/goal runs 50` to set one (`0` disables it). Pause lets the current response finish; Stop also aborts it. Usage counts provider-reported uncached input plus output after each response, so a response can exceed the remaining budget. Child usage remains in the separate subagent budgets. Reopening a runtime/branch restores an active goal as paused; browser reconnects preserve the live runtime.
- **Plan:** `/plan <request>` explores with restricted tools and saves up to 30 ordered steps. Review/refine through the Plan panel or `/plan refine <changes>`, then explicitly choose `/plan execute`; execution stays in the same session and restores the prior tool selection. `/plan cancel` leaves the conversation intact. The `update_plan` tool tracks verified progress, including independent steps running in parallel. Markdown summaries are accepted; result cards are optional. Goal and plan state survive compaction in custom session entries. Planning pauses an active Goal. Shell filtering prevents common accidental writes; it is not an operating-system sandbox.
- **Agents → Subagent budgets** configures time, turns, and reported cost for new children (no fixed default caps; `0` disables a limit and saved user settings are preserved). Turns/time apply per child; cost is shared across one delegation including retries. The model may allocate smaller budgets, never increase user caps. Workers inherit only active parent tools, including MCP/extensions; task tool lists can narrow that access. Active runs show a near-limit notice and can be extended without starting another session. Reported cost depends on provider usage data, not your billing balance; checks occur after each response, so parallel in-flight usage can exceed the remaining budget.
- A built-in `ask_user` tool plus Pi extension dialogs (`select`, `confirm`, `input`, and `editor`), notifications, status indicators, and text widgets; pending decisions survive reconnects.
- Settings use collapsible, nonblocking panels; the composer stays available. Drafts survive rapid session switches and reloads, and reading positions are remembered within the browser tab. Quiet active sessions are not recycled by the idle timer.
- Reviewed sensitive actions have no reading countdown. Confirmations remain single-use and target-bound; changed content, server restarts, or a full pending-review cache require another review.
- Large text previews load in 256 KiB chunks up to 2 MiB, with full-file open/download links. Partial previews cannot be saved over the original file.
- Pi extension session commands (`newSession`, `fork`, and `switchSession`) use the native `AgentSessionRuntime`; the Web UI follows the replacement session and reconnects SSE to it.
- Replacement failures restore the previous runtime, active-session conflicts are rejected before switching, and every open tab follows the same replacement. Extensions settings expose live runtime diagnostics.
- Import a Pi `.jsonl` through a preview-first dialog that validates its header, effective cwd, allowed roots, symlinks, size, and destination collision before switching.
- Per-run error cards, stall warnings, notifications, completion sound, and React-owned tab status.
- Editable past turns, retry from the previous branch point, independent forks, and in-session branch navigation.
- Clone the active branch into a separate session, or start an ephemeral session that intentionally leaves no JSONL after a server restart.
- Provider errors are classified (rate limit, billing, auth, outage, network, or context) with one-click fallback and an opt-in single automatic cross-provider retry.
- Project trust can be reviewed and changed from the Context inspector. Extension shortcuts can be invoked from the Extensions panel, while TUI-only custom messages receive a safe generic Web rendering.
- Extensions settings include a Runtime status center and an MCP manager for trusted stdio or Streamable HTTP servers; MCP tools are bridged through Pi's supported Extension API rather than patching Pi core.

### MCP connections

For MCP setup, timeout units, one-time tests, connection cleanup, paginated tools
and current protocol limits, see [MCP connections](docs/MCP.md). The editor uses
**1–120 seconds**; stored `timeoutMs` values remain milliseconds. Tests use a
separate connection and never replace an agent's shared connection. Tool-list
changes require **Reload Extensions** after the active run; OAuth/PKCE,
resource/prompt browsing and required-task execution are not yet integrated.
Saved configurations use revision checks and cross-process locking. Conflicting
edits keep your draft; reload the latest record explicitly before retrying. New
records are capped at 50; existing entries are never silently truncated. See the
MCP guide for API revisions, validation limits and saved-but-reload-failed warnings.

### Attention and recovery

- A global Attention Center combines failed sessions, background agents, scheduled runs, and agents waiting for a decision; read state stays per device.
- Optional Web Push works after explicit browser enrollment. Remote enrollment requires the app access gate; localhost works without a password. Push payloads are deliberately generic and never contain prompts, repository paths, or error text.

### Scheduled agents

- The left-rail Schedule Center supports one-time, daily, weekly, and five-field cron schedules with an explicit IANA timezone.
- Choose the project, prompt, model, thinking level, tool access, missed-run policy, and whether the schedule is active; pause, resume, run now, retry, or inspect run history from one panel.
- Every run creates a normal local Pi session. If `ask_user` needs a decision, the run changes to **Waiting for input** and opens directly into that session.
- Scheduling is provided by the local Node server, with a visible heartbeat, next-wake health, missed-run accounting, and an optional independent watchdog (`npm run scheduler:watch`) that wakes the runner through its local endpoint. On restart, each schedule either catches up once or skips the missed run according to its policy, and overlapping runs are never started.

### Sessions and navigation

- Incremental, read-only session index over local Pi `.jsonl` files.
- Search, tags, pins, archive, auto-naming, HTML/Markdown export, and usage analytics.
- Conversation find, user-turn navigation, bookmarks, minimap, long-message collapse, and optional always-follow streaming.
- Project switcher with recent projects, pins, discovery, filesystem completion, and linked git worktrees.
- Reusable prompt templates alongside built-in `/tgd-*` commands.
- Local hybrid semantic search spans session history, tGD artifacts, and project source, alongside exact filename/content search.

### Files and git

- Attach images or general files using the composer's paperclip or drag-and-drop. Documents are saved in the selected project (up to 50 MB each) and inserted as `@file` references; their contents are read with the agent's available tools, not automatically extracted. Upload errors remain inline with retry/dismiss actions. Removing a reference does not delete the saved file.
- The Files explorer has a visible **Upload files** button. Uploads never overwrite an existing filename.

- Project tree, recursive filename search, text editing, Markdown/HTML/image preview, and clickable file paths in chat.
- Git-aware badges, working-tree summary, per-file statistics, and `HEAD` versus worktree diffs.
- Tool-call presentation for `edit` and `write` operations instead of raw JSON.
- Allowed-root checks, path guards, `execFile` git calls, and response-size limits on file and git APIs.
- Snapshot restore applies a precise delta and never rewrites the user's index or `HEAD`.
- The file inspector includes symbols, definition/reference lookup, TypeScript/ESLint/related-test diagnostics, Git history, blame, and agent snapshots.

Text editing requires the revision returned when the file was loaded. If the
file changes on disk, Save keeps your draft and shows a disk-versus-draft
comparison. Review or merge the content before choosing **Save this draft**;
that retry checks the reviewed revision too, so another change cannot silently
be overwritten. **Discard draft and use disk** explicitly replaces the draft.
Failed saves and same-file navigation keep the editor open.

Saves recheck the revision before a same-directory atomic replacement. Web
instances sharing the same local Pi agent directory use a per-file OS-backed
mutex for saves and hunk restores. A busy file is rejected immediately; a
process crash releases its lock without a timed takeover. Node's built-in
SQLite provides the mutex, with no additional CLI or native npm addon. Node 22
may print an experimental SQLite warning on the server's first file mutation.

Keep `<agent-dir>/file-mutation-locks/` on a local filesystem, private to the
server account. The Web file API excludes this internal directory from reads,
search, uploads and creation, and refuses moves/deletions of it or its parents.
External programs must not read, remove or replace these empty lock database
files while any instance is running. All instances that modify the same
workspace must share this directory; separate agent directories and external
editors do not participate. This is not an OS-level filesystem sandbox and
does not prevent an external program from racing the final version check.
Large, partial, binary and invalid UTF-8 previews cannot be saved as text. The
edit endpoint does not create a deleted file.

HTML previews run embedded scripts in an opaque-origin sandbox. The server
applies Content Security Policy to raw HTML/SVG responses as well as the viewer,
so opening a raw URL does not grant access to app cookies, storage or APIs.
SVG and converted DOCX previews cannot execute scripts. Local/external script
and asset dependencies, network requests, forms, popups and parent-page
navigation are blocked; self-contained HTML and embedded data/blob media are
supported. The viewer's **Isolated preview** disclosure explains these limits.
This is not an OS sandbox, and a standalone HTML tab can still navigate itself.

API reads also check browser origin metadata, including navigation from an
opaque-origin preview. Cross-origin API links are refused: open the app first,
then use its controls. Normal app entry links, address-bar navigation and CLI
clients remain supported. This is defense in depth, not authentication; remote
access still needs the password gate or a trusted access proxy.

Downloads use bounded, pull-driven reads, support single byte ranges and release
their file descriptor on completion, cancellation or disconnect. A file changed
during transfer aborts the response instead of silently mixing versions; retry
the download to obtain the current file.

### Rendering and appearance

- GitHub Flavored Markdown, tables, task lists, KaTeX, Mermaid, and lazy-loaded syntax highlighting.
- Editorial, Terminal, Industrial, Aurora, and Glass skins, each in light and dark mode.
- Bundled Inter, JetBrains Mono, and Noto Sans TC fonts with no CDN dependency.
- Application UI languages: English and Traditional Chinese. These project documents are also available in Japanese and German.

## Keyboard Shortcuts

| Keys | Action |
|---|---|
| `⌘/Ctrl + K` | Open command palette |
| `⌘/Ctrl + P` | Open project switcher |
| `⌘/Ctrl + F` | Find in the conversation |
| `⌥ + ↑` / `⌥ + ↓` | Previous / next user turn |
| `⇧⌘M` | Open Models |
| `⌘/Ctrl + /` | Open Skills |
| `⌘/Ctrl + B` | Toggle contextual panel |
| `⌘/Ctrl + \` | Toggle right file panel |
| `↑` in an empty composer | Recall the previous message |
| `Esc` | Close the active dialog |

## Commands

| Command | Purpose |
|---|---|
| `bash setup.sh` | Check/backup local changes, synchronize `origin/main` after approval where required, install, validate, build and optionally start |
| `bash scripts/release.sh` | Read-only release preflight; `--dispatch` explicitly requests the GitHub workflow |
| `npm run dev` | Development server on `127.0.0.1:30141`, using the selected Pi data directory |
| `npm run preview` | Independent functional preview on `127.0.0.1:30142`, with its own empty `.pi-web-preview/agent` directory |
| `node_modules/.bin/tsc --noEmit` | Typecheck |
| `npx eslint .` | Lint |
| `npm test` | Run Vitest unit tests |
| `npm run test:e2e` | Build and run Playwright E2E on port `30177` |
| `npm run build` | Create a production build |
| `npm run start` | Start the production server |

> [!WARNING]
> Stop `npm run dev` before `npm run build` or `npm run test:e2e`. A concurrent Next.js build corrupts the running development server's `.next/` directory.

Playwright is intentionally installed ad hoc and is not saved in `package.json`:

```bash
npm i -D --no-save @playwright/test
npm run test:e2e
```

For a local container with a preinstalled Chromium:

```bash
PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e
```

## Configuration

`dev` and `start` bind to localhost by default. `PORT=30143 npm run dev` changes the port; an explicit `-- -p 30143` takes precedence. Remote binding requires deliberate `PIWEB_HOST=0.0.0.0` or `-- -H 0.0.0.0` and an authenticated access boundary. Preview mode stays localhost-only.

The environment bar identifies development, production, functional preview, or demonstration data and shows the running build and actual model-config path. `npm run preview` does **not** automatically copy credentials, sessions, or schedules. To reuse your normal models, stop the preview and run `npm run preview:configure` (or append `-- --source /path/to/agent`), then restart it. This explicitly copies model definitions and model defaults, backs up the previous preview configuration privately, and links the same login store so OAuth refresh uses one canonical lock. Login/logout changes affect both environments; model-definition edits remain separate. Sessions, schedules, packages and extensions are not copied. Alternatively configure separate accounts in the preview Models screen without running this command. Inherited provider environment variables are excluded, and automatic private `.env` loading is refused. Use a clean checkout for preview if your normal checkout has private `.env` files. This is data separation, not an OS sandbox.

The launcher creates a private provenance marker in a new empty preview directory. Existing non-empty directories must already carry the matching marker; an arbitrary copied agent directory is refused. Fixture generators create their own fixture marker.

| Setting | Behavior |
|---|---|
| `PI_CODING_AGENT_DIR` | Overrides the default `~/.pi/agent` directory |
| `PORT` / `PIWEB_HOST` | Default `30141` / `127.0.0.1`; preview defaults to port `30142` |
| `PIWEB_PREVIEW_DIR` | Absolute independent agent-data directory for `npm run preview`; cannot be the real Pi data directory or an alias |
| `PIWEB_ENVIRONMENT` | Explicit `development`, `production`, `preview`, or `fixture` identity; fixture requires isolated agent data |
| `PIWEB_ACCESS_PASSWORD` | Enables the built-in shared-password gate for every route |
| `PIWEB_SESSION_SECRET` | Signs access cookies independently from the password; use a random 32-byte-or-longer value for remote deployments |
| `PIWEB_RELEASE_REPOSITORY` | GitHub `owner/repo` used by the Update Center; defaults to `yhwangtw/tgd-pi-web` |
| `PIWEB_UPDATE_BACKUP_DIR` | Private source-backup directory outside the application checkout; defaults under the Pi agent data directory |
| `PIWEB_UPDATE_COMMAND_JSON` | Absolute JSON argv array for an operator-managed update helper; no shell parsing |
| `PIWEB_RESTART_COMMAND_JSON` | Absolute JSON argv array for an operator-managed restart helper |
| `PIWEB_ROLLBACK_COMMAND_JSON` | Absolute JSON argv array for an operator-managed rollback helper |
| `PIWEB_UPDATE_PROTOCOL` | `staged-v1` is required for managed update/rollback |
| `PIWEB_UPDATE_HEALTH_URL` | Loopback `/api/runtime/identity` URL for running-process verification |
| `PIWEB_UPDATE_OPERATION_DIR` | Private durable directory outside source; shared by instances managing the same service |
| `TGD_DIR` | Overrides the sibling `<project>-tGD/` artifact directory |
| `models.json` | Model/provider catalog, including custom `baseUrl` values |
| `auth.json` | Per-provider API credentials managed by Pi |
| Project picker | Selects and validates the active working directory |

Session files remain in Pi's native format:

```text
~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl
```

## Architecture

```text
Browser                    Next.js server             AgentSessionRuntime
  │                              │                            │
  ├─ GET /api/sessions ─────────▶│ incremental .jsonl cache   │
  ├─ POST /api/agent/[id] ──────▶│ startRpcSession() ────────▶│
  ├─ GET /events (SSE) ─────────▶│◀──── session events ───────│
  ├─ GET /api/files/* ──────────▶│ allowed-root file access   │
  ├─ GET /api/git/* ────────────▶│ guarded git inspection     │
  └─ GET /api/tgd/artifacts ────▶│ sibling tGD directory      │
```

Read-only browsing parses session files without creating an `AgentSession`. Sending a message creates one in-process runtime wrapper per active session and streams events over SSE. Pi owns session replacement; the wrapper rebinds cwd-scoped services, extensions, registry keys, and event subscriptions to the new `AgentSession`.

## Project Structure

```text
app/api/        sessions, agent commands/events, schedules, files, git, tGD, config
components/     layout, chat, sidebar, modals, and shared UI
hooks/          agent orchestration, streaming, scrolling, sessions, theme
lib/            RPC lifecycle, scheduling, session parsing, security, i18n, snapshots
e2e/            Playwright production-server scenarios
docs/           screenshots and project documentation
public/fonts/   bundled local fonts
```

See [`AGENTS.md`](./AGENTS.md) for the detailed architecture, invariants, and development traps.

## Offline and Air-Gapped Use

Fonts and UI assets are bundled. In an air-gapped environment, model endpoints must be reachable internally, the Runtime panel reports the public version check as unavailable, and only MCP servers you explicitly configure are contacted.

- **Internal npm registry:** clone this repository or extract a GitHub Release source archive into a clean directory, configure npm for the internal registry, then run `bash setup.sh`. Use `npm ci && npm run build` only when an immutable CI-style install is required.
- **Portable directory:** on a networked machine with the same OS and architecture, run `npm ci && npm run build`, copy the complete directory, then run `npm run start`.
- **Internal or local model:** set a custom provider `baseUrl` in `models.json`.

`npm ci` is retained for reproducible CI and offline builds; interactive development uses `npm install`.

## FAQ

### Is this published as an npm package?

No. Install and update it from the GitHub repository or a GitHub Release source archive.

### Does it replace Pi?

No. It is a local browser interface over Pi's session files and agent runtime. Pi remains the underlying coding agent.

### Does the app upload my sessions?

The application does not include a hosted session backend. It reads local Pi files and contacts only the model/provider endpoints you configure.

### Do schedules run while tGD Pi Web is stopped?

The agent execution runtime still needs the local Node server. Keep `npm start` running; for a separate wake/health process, run `npm run scheduler:watch` under launchd/systemd. After a restart, each schedule applies its configured **run once** or **skip** missed-run policy.

### Why is Playwright not in `package.json`?

Its transitive postinstall may download browser binaries and break offline or Nexus-based `npm ci`. CI installs it with `--no-save` before E2E.

### Why can a compacted session still be long?

Compaction adds a summary and keeps a recent tail; it does not delete the original history from the `.jsonl` file. The UI follows Pi's active branch and compaction entry.

## Contributing

Issues and pull requests are welcome.

1. Fork the repository and create a focused branch.
2. Use `npm install` for development.
3. Run typecheck, lint, and tests.
4. Add or update tests for behavior changes.
5. Keep all four README files aligned when changing user-facing setup or features.

Improve application translations in `lib/i18n.tsx`. New skins must use semantic design tokens rather than hardcoded component colors.

## Release

After merging, wait for CI on the exact `main` source. Run from any checkout;
local edits and private files are preserved:

```bash
bash scripts/release.sh                        # preflight, automatic UTC tag
bash scripts/release.sh --dispatch             # publish with automatic tag
bash scripts/release.sh vYYYY.MM.DD --dispatch  # optional explicit tag
```

The helper prepares remote main in an isolated checkout and chooses the next UTC
date/sequence. Documentation changes use lightweight CI; normal changes use
representative runtimes, and compatibility changes/manual runs use the full
matrix. Main reuses the latest successful PR checks only for an identical source
tree, otherwise it runs checks itself. Publication independently rechecks CI and
pins the source SHA before atomically publishing a version commit/tag. Existing
tags never move. This does **not** publish to npm or deploy production. See the
[release, recovery and readback guide](./docs/RELEASING.md).

With operator-configured staged deployment adapters, use
`bash scripts/release.sh vYYYY.MM.DD --deploy /absolute/plan.json --execute`
to publish, wait, deploy and verify the public hostname. Omit `--execute` for
read-only preflight; repeat the same tag/plan to resume completed stages.
See [pipeline configuration and recovery limits](./docs/RELEASE-PIPELINE.md).
Documentation-only and CI-only changes normally need only a merge.

## License

MIT — see [`LICENSE`](./LICENSE).
