# Pi Agent Web - Development Notes

## Quick Start

```bash
npm run dev   # port 30141
```

Typecheck: `node_modules/.bin/tsc --noEmit`  
Lint: `npx eslint .`  
Tests: `npm test` (vitest)  
E2E: `npm run test:e2e` (Playwright — builds and boots a production server on
:30177 with generated fixtures; **stop `npm run dev` first**, the build step
corrupts a running dev server's `.next/`. Local containers with a
preinstalled browser: `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e`.)
**@playwright/test is deliberately NOT in package.json** — its transitive
postinstall downloads browser binaries and would break offline/Nexus
`npm ci`. Install it ad hoc first: `npm i -D --no-save @playwright/test`
(CI does exactly this). `e2e/` + `playwright.config.ts` are excluded from
tsconfig/eslint for the same reason.  
**Never run `next build` while the dev server is running** — pollutes `.next/` and breaks `npm run dev`.

Release: after PR CI passes and the PR is merged, run
`gh workflow run release.yml -f tag=vYYYY.MM.DD`. New tags must use the current
UTC date; for another release on the same date, append a sequence such as
`vYYYY.MM.DD-1`. The workflow updates both
package version files, creates the `[skip ci]` release commit and annotated tag,
and publishes the GitHub Release in one run. Do not manually create a version
commit or wait for duplicate main/version CI runs. A pre-versioned `v*` tag push
remains a compatibility path. There is no npm publish step.

Production setup: `bash setup.sh` treats `origin/main` as authoritative for Git
checkouts. It runs `git fetch --prune origin main`, `git reset --hard
origin/main`, and `git clean -fd`, then re-executes the fetched script. This
intentionally discards local commits, tracked changes, and non-ignored untracked
files; ignored runtime state remains. `TGD_SETUP_OFFLINE=1 bash setup.sh` is the
explicit offline escape hatch. Source archives skip Git synchronization and
back up known obsolete search files outside the source tree before building.

E2E traps: transcript text offscreen is `content-visibility`-skipped and
Playwright calls it *hidden* — anchor on sidebar text or use `toBeAttached`,
scroll before visibility asserts. UI strings use the ellipsis character
(`Message…`, `Filter files…`), not three dots.

---

## Architecture

```
Browser                Next.js Server          AgentSessionRuntime (in-process)
  │                        │                               │
  ├─ GET /api/sessions ────▶ incremental cache over        │
  │                        │  ~/.pi/agent/sessions/        │
  ├─ send message ─────────▶ POST /api/agent/[id]          │
  │                        │   startRpcSession() ─────────▶│ createAgentSessionRuntime()
  │                        │   session.send(cmd) ─────────▶│ prompt/steer/bash/…
  ├─ SSE connect ──────────▶ GET /api/agent/[id]/events    │
  │◀── data: {...} ─────────│   session.onEvent() ◀────────│ session.subscribe()
  ├─ schedules ─────────────▶ GET/POST /api/schedules      │
  │                        │   ScheduleRunner ────────────▶│ new normal session
  ├─ GET /api/git/changes ─▶ git status (allowed cwds)     │
  └─ GET /api/git/file-diff▶ HEAD vs worktree contents     │
```

**Session browsing** (read-only): parses `.jsonl` files via `lib/session-reader.ts` — no AgentSession created.  
**Sending a message**: `startRpcSession()` in `lib/rpc-manager.ts` creates an `AgentSessionRuntime` in-process. The runtime owns the active `AgentSession` and native new/switch/fork replacement lifecycle.

### Layout (post-redesign)

Icon rail (44px, `AppShell`) → contextual panel (Sessions | Schedules | Files | Changes) → chat (session-scoped top bar + transcript + input) → right panel (file viewer / diff). Rail bottom: Models / Skills / Language / Theme. Global hotkeys live in one `AppShell` effect — **every hint shown in the ⌘K palette must be bound there**.

---

## File Map

```
app/api/
  sessions/…                      list/read/patch/delete, context, export(+md),
                                  search, tags, pins, analytics
  agent/new/route.ts              POST { cwd, message, toolNames?, provider?, modelId? }
  agent/[id]/route.ts             GET state | POST any command (see rpc-manager)
  agent/[id]/events/route.ts      GET SSE stream (30s comment heartbeats)
  agent/[id]/import/route.ts      POST preview/import a validated Pi JSONL
  agent/[id]/summarize/route.ts   POST — auto-naming (skips named sessions)
  schedules/route.ts              GET list/history | POST create
  schedules/[id]/route.ts         PATCH update/pause | DELETE
  schedules/[id]/run/route.ts     POST — start an immediate run
  git/changes/route.ts            GET ?cwd= — status --porcelain + numstat
  git/file-diff/route.ts          GET ?cwd=&path= — HEAD vs worktree text
  files/search/route.ts           GET ?cwd=&q= — recursive filename search
                                  (BFS, allowed-roots gated, 200/depth-8 caps)
  cwd/browse/route.ts             POST {path} — dirs-only listing for the
                                  project picker (same trust model as
                                  cwd/validate: picking a NEW workspace may
                                  point anywhere; it becomes an allowed root)
  files/, models*, auth/, skills/, cwd/   unchanged surfaces

lib/
  rpc-manager.ts      AgentSessionRuntime host + wrapper registry + command dispatch
                      (prompt/steer/follow_up/fork/bash/clear_queue/…);
                      owns the WebExtensionUIBridge and ask_user tool
  schedule-core.ts    timezone-aware once/daily/weekly/5-field-cron math
  schedule-store.ts   atomic <agent-dir>/schedules.json persistence
  schedule-runner.ts  process timer, run lifecycle, history + ask_user wait
  session-reader.ts   incremental listing (stat cache) + context building
  session-import.ts   allowed-root JSONL validation + collision-free preview
  i18n.tsx            en/zh-TW strings — module store, useI18n()/translate()
  skin.ts             appearance skins — html[data-skin] token overrides
  font-size.ts        persisted UI font scale — html[data-font-size]
  font-family.ts      persisted UI typeface — html[data-font-family]
  prefs.ts            small persisted UI prefs (always-follow stream)
  attention.ts        tab title store (React-rendered <title>) + notifications
  file-security.ts / file-mime.ts / file-stream.ts / file-paths.ts
  normalize.ts        toolCall field-name normalization
  types.ts            shared types (incl. BashExecutionMessage)

components/
  layout/   AppShell (layout wiring + hotkeys), IconRail, ShortcutsDialog,
            SchedulePanel, FilesPanel, ChangesPanel, DiffPanel, FileViewer, TabBar,
            ErrorBoundary, text-viewer/
  chat/     ChatWindow (find/⌘F, follow-mode scroll, ⌥↑/⌥↓ turn nav, status
            line, bookmarks), CollapsibleMessage (long-history clamp),
            turn-nav.ts, ChatInput (history ↑, bash prefix), MessageView,
            BashBlock, UserQuestionCard + ExtensionUIPanel (ask_user and
            extension dialogs/status/widgets), AssistantMessageView (error card, edit/write tool
            diff view), BranchNavigator, ChatMinimap, MarkdownBody (lazy
            KaTeX/Mermaid/PrismAsync)
  sidebar/  SessionSidebar (+embedded explorer, showExplorer prop, archived
            toggle), SessionItem, SessionContextMenu (tags/archive/delete),
            FileExplorer, CwdPicker, TagFilter
  modals/   ModelsConfig, SkillsConfig, AnalyticsModal, ToolPanel,
            SessionImportDialog
  ui/       CommandPalette, Toast, Skeleton

hooks/    useAgentSession (chat orchestration; extracted pieces live in
          use-agent-connection.ts — SSE + stall watchdog,
          use-extension-ui.ts — reconnect-safe extension UI state,
          use-transcript-scroll.ts, use-model-catalog.ts, and
          use-agent-session-types.ts — reducer + computeSessionStats),
          useAppShellState, useRightPanelWidth, useCommandPalette,
          useSessions (pins + archive), useToast (global store), useTheme,
          useExplorer (persisted), …
```

---

## Key Design Decisions & Traps

### Module-level stores (theme / toast / i18n / skin / typography / attention)
Cross-cutting client state uses module-level stores + `useSyncExternalStore`
— no context providers. **Do not** create per-instance state for these:
`useToast` was once per-instance and SessionSidebar's toasts silently never
rendered (its container wasn't mounted). One store, one `<ToastContainer />`
at the app root.

### Font-size preference
Appearance offers Small / Default / Large / XL through the module-level store
in `lib/font-size.ts`. The preference is persisted as `pi-font-size` and applied
to `<html data-font-size>` by both the store and the no-flash script in
`layout.tsx`. `--font-scale` in `globals.css` drives all UI typography; fixed
CSS and inline pixel sizes use `calc(<size> * var(--font-scale))`. New font-size
declarations must use an existing `--text-*` token or the same calculation so
they participate in the preference.

Typeface selection follows the same pattern in `lib/font-family.ts`, persisted
as `pi-font-family`. `--font-ui` selects the bundled sans stack, bundled mono
stack, or system stack; code remains on `--font-mono` regardless of UI choice.

### React 19 owns `<title>` — never write `document.title`
Layout metadata is hoisted by React; raw `document.title` writes get
clobbered on the next render (root-caused via a setter trace). The tab title
is a store in `lib/attention.ts` rendered as `<title>{useTabTitle()}</title>`
in AppShell. Layout `metadata` deliberately has **no** `title`.

### StrictMode double-invocation
Never call a state setter inside another setter's updater — updaters run
twice in dev and a toggle cancels itself (bit us in the rail view switch).
Side effects (localStorage writes) inside updaters are tolerated only when
idempotent.

### Session listing is a stat-based incremental cache
`lib/session-reader.ts` walks the sessions dir, `stat()`s each file, and
re-parses only changed ones with pi's pure `parseSessionEntries`.
**Do not use `SessionManager.open()` for read-only scanning** — it rewrites
empty/corrupted files as a side effect. Cache lives on `globalThis`
(hot-reload safe); entries for deleted files are evicted each pass. A cached
future path is returned only after the file exists — Pi does not write a new
session until its first assistant response, and opening that future path would
otherwise manufacture a phantom session.

### AgentSession lifecycle (`lib/rpc-manager.ts`)
- One `AgentSessionWrapper` per session id, keyed in `globalThis.__piSessions`
- Idle timeout 10 min; concurrent `startRpcSession()` share a start Promise
- The wrapper hosts Pi's `AgentSessionRuntime`. Native `newSession()`, `fork()`,
  and `switchSession()` replace the inner session while the wrapper survives.
  The runtime's invalidation/rebind callbacks clear old extension UI, recreate
  cwd-bound services, rebind extensions and event subscriptions, and rekey the
  global registry. `session_replaced` is emitted only after the entire operation,
  including `withSession`, succeeds. Browser POST responses and SSE events may
  both carry the new id; client navigation is deliberately idempotent.
- Replacement failures rebuild the previous runtime and surface recovery state
  in the composer and Extensions diagnostics. A target already owned by another
  live runtime is rejected before invalidation, preserving the active session.
- Every replacement event is mirrored through `BroadcastChannel` (with a
  localStorage fallback) so idle tabs displaying the outgoing session follow it.
- JSONL import is preview-first: source path, effective cwd, destination, header,
  allowed-root containment, symlink escape, size, and destination collision are
  validated before Pi's native `importFromJsonl()` replaces the runtime.
- `bash` command wraps `executeBash` and streams synthetic
  `bash_start/bash_chunk/bash_end` events through the wrapper's listeners →
  existing SSE channel. pi records the result itself (role `bashExecution`).

### Scheduled agents (`lib/schedule-*.ts`, `instrumentation*.ts`)
- Definitions and the newest 500 runs live in `<agent-dir>/schedules.json`;
  writes use temp-file + rename. UI/API mutations never write project files.
- `instrumentation.ts` must conditionally import `instrumentation.node.ts`
  *inside* `process.env.NEXT_RUNTIME === "nodejs"`. Importing the runner at the
  top level makes the Edge instrumentation bundle follow Pi's `fs` and
  `child_process` dependencies and breaks production builds. Never start the
  runner during `phase-production-build`.
- The global `ScheduleRunner` owns one nearest-deadline timer. On restart it
  marks persisted running/waiting runs failed, then applies each schedule's
  catch-up-once or skip policy. A schedule can never have overlapping runs.
- Once/daily/weekly/cron calculations are dependency-free and IANA-timezone
  aware, including DST gaps/repeated minutes. Cron is the standard five-field
  form; DOM/DOW use the usual OR rule when both fields are restricted.
- A run creates a normal persisted Pi session with the configured cwd/model/
  thinking/tools. The runner sends `prompt` with `awaitCompletion:true`; normal
  browser prompts remain fire-and-forget. Do not remove that distinction — an
  immediate model/setup rejection otherwise leaves a run stuck as `running`.
- Dialog requests (`ask_user`, select/confirm/input/editor) change the run to
  `waiting_for_input`. Opening its session replays the pending request; a
  keepalive prevents the normal 10-minute idle shutdown while it waits.
- This is an in-process local scheduler: the production Node server must stay
  running for on-time execution. It is intentionally not an OS daemon.

### Scroll contract (ChatWindow + useAgentSession)
- On send: user message anchors to the viewport top immediately (never smooth;
  fast replies can otherwise finish before the anchor animation); a
  viewport-height spacer below lets the answer stream in without jumps.
- End of run: never infer follow intent from the post-layout distance. Removing
  the viewport spacer can clamp `scrollTop` to the new maximum and make an
  anchored reader look like they were at the tail. Shrink the spacer to the
  minimum filler needed to preserve the viewport; engaged streaming follow is
  already pinned, and only explicit always-follow may move an idle reader.
- Streaming follow: engaged only by user scrolls into the bottom zone (or the
  jump button) — content growth never changes engagement. Instant scrolls,
  not smooth (smooth queues jitter at token rate).
- Jump-to-bottom uses `block:"end"` — `block:"start"` + spacer can scroll the
  conversation out of the viewport.
- **The end marker renders BEFORE the run spacer.** Follow mode and the jump
  button pin to the marker; if it sat after the spacer, following a stream
  would park the viewport in the spacer's blank space instead of on the text.
- Long-message collapse (`CollapsibleMessage`): history taller than 720px
  clamps to 380px behind a fade; the current turn (last user message onward)
  is exempt. Measured in a layout effect (no first-paint jump). ⌘F's
  `gotoMatch` pre-expands the target via `visibleKeys` before scrolling.
- ⌥↑/⌥↓ turn nav (`turn-nav.ts`): the pick epsilon (16px) must stay larger
  than `.msg-item`'s `scroll-margin-top` (10px) or "next" re-selects the
  currently-aligned message and the jump goes nowhere.
- "+N lines" counter on the jump button: baseline = scrollHeight, re-anchored
  on run start/end, spacer resize, expand/collapse, and whenever the reader is
  at the tail. Only counts while running and not following.
- Always-follow preference (`lib/prefs.ts`, `pi-follow-stream`): read by
  ChatWindow (engage follow at run start) AND useAgentSession (end-of-run
  scroll gate). Toggled from the ⌘K palette, default off.

### Run outcome signals
`agent_end` events carry `messages`; `getRunError()`
(hooks/use-agent-session-types.ts) reads the last assistant message's
`stopReason`. Failures: red error card (AssistantMessageView), error toast,
⚠ title, failure notification, **no** completion sound. Stall watchdog: 60s
without an SSE event (120s during tool runs) shows a warning — SSE heartbeats
are comments and don't reset the clock.

### Appearance skins and interface styles
Color palettes and component geometry are independent. `lib/skin.ts` persists
the palette as `pi-skin` and applies `html[data-skin="…"]`; `lib/ui-style.ts`
persists Original/TRAE geometry as `pi-ui-style` and applies
`html[data-ui-style="trae"]`. TRAE component selectors must use the latter,
while palette blocks stay on `data-skin`. Components read CSS variables only —
**never hardcode colors**. The default combination is TRAE geometry + TRAE
violet. The no-flash script in `layout.tsx` applies both preferences and keeps
legacy explicit non-TRAE palettes on Original geometry.

Glass layer: `--glass-bg`/`--glass-border` are derived from each skin's own
surfaces via `color-mix` in `:root`, so all skins get matching frosted chrome
(palette, dialogs, toasts, find bar, jump button, top bar) for free. The
`glass` skin overrides them and sets translucent surface tokens over a fixed
body gradient; its `--bg-elev-*` stay near-opaque on purpose — dropdowns have
no backdrop blur and must stay readable over arbitrary content.

Inline-style trap: react-syntax-highlighter themes mix `background` and
`backgroundColor`; `MarkdownBody`'s customStyle pins **both** so the merged
style stays stable across theme switches (React dev warns otherwise).

### cwd-follow must not reset the view
The sidebar follows the open session's cwd (cross-project selection). That
notification flows through `handleCwdChange`, whose reset path calls
`router.replace("/")` — guarded by `selectedSessionRef`: when the new cwd
matches the open session, skip the reset or the `?session=` URL param (and
reload-restore) silently breaks.

### Session tags — one canonical shape
The server (`/api/sessions/tags`, `<agent-dir>/tags.json`) stores
`sessionId → [tags]`. The client (`useTags`) **inverts on load** to
`tag → [sessionIds]` and everything client-side uses that shape: TagFilter,
palette, filtering, and `sessionTagsOf()` for per-item chips. Never index the
client map by session id — that mismatch once made chips render only after a
reload and removal appear to no-op.

### File snapshots (`lib/git-snapshot.ts`)
Git-backed restore points captured before each run (rpc-manager's `prompt` case
+ the `/tgd-*` command route call `createSnapshot`). Uses a throwaway
`GIT_INDEX_FILE` to `add -A` + `write-tree` (never touches the user's index/HEAD),
`commit-tree` the result, and keeps it via `refs/pi/snap/<sessionId>/<id>`.
Metadata in `<agent-dir>/snapshots/<sessionId>.json`. **Restore is a precise
delta**: diff snapshot-commit vs current working tree, then per file — M/D
`git checkout <snap> -- file`, A (created since) `rm`. Path-guarded to stay
inside cwd. Dedup by tree sha; cap 20/session. Git repos only.

### tGD artifacts (`lib/tgd-artifacts.ts`, `components/layout/TgdArtifactsPanel.tsx`)
The tGD workflow writes its docs to a **sibling** `<project>-tGD/` dir (or
`$TGD_DIR`), *outside* the code repo — `CONTEXT.md`, `TRACKING-PLAN.md`, `wiki/`,
and per-feature dirs (a "feature" = a dir with `PRD.md` or `SPEC.md`) holding
PRD/SPEC/DESIGN/TASKS/TEST-REPORT/REVIEW/METRICS + `prototype/*.html`; release
also maintains top-level `CHANGELOG.md` and optional `REGRESSION-CATALOG.md`.
`resolveTgdDir(cwd)` finds it;
`getAllowedRoots()` adds it so the file viewer can open those docs. The `tgd`
rail view lists them and maps docs → phases (PRD/SPEC→define, TASKS→plan,
TEST-REPORT→verify, REVIEW→review, METRICS→release) for the pipeline echo.
`.scans/` and dot-dirs are infra, excluded. API: `GET /api/tgd/artifacts`.
The panel has two views (toggle persisted in `localStorage["pi-tgd-artifacts-view"]`):
**Artifacts** (the curated per-feature/phase view above) and **Files** — a lazy
tree of the *whole* tGD dir (nothing excluded: `.scans/`, `wiki/docs/`, prototypes),
built on the existing `GET /api/files/<abs>?type=list` endpoint (the tGD dir is an
allowed root, so its subtree lists/reads without extra wiring).

### tGD pipeline (`components/chat/TgdPipeline.tsx`)
Always-visible phase bar at the top of the session view. `PHASE_ACTIONS`
(ChatWindow) is the source of the seven phases. Status is **hybrid**: ChatWindow
fetches `/api/tgd/artifacts?cwd=` and marks `map`/`define`/`plan` done from real
on-disk artifacts (same truth as the artifacts panel — `map` = CONTEXT/wiki
exists, `define`/`plan` = the current feature's `phasesDone`, plan also if
`TRACKING-PLAN.md` exists). Verify/review/release also use the current feature's
TEST-REPORT/REVIEW/METRICS evidence; `develop` remains transcript-driven because
it produces code rather than a tGD document. Disk evidence is unioned with the
session's invoked `/tgd-*`. `current` = the last `/tgd-*` typed this session, else the next phase
after the furthest with evidence (so a fresh project highlights `map`). The bar
is **feature-aware**: the tracked feature is the one named in the last `/tgd-*`
command if it matches a feature dir, else the most-recently-touched feature
(`TgdFeature.mtimeMs`), shown as a chip. Artifacts are refetched on cwd change
and whenever the agent stops. Clicking a phase calls
`chatInputRef.setText("/tgd-x ")` (no auto-send). Dismiss state is
`localStorage["pi-tgd-pipeline-hidden"]`. The current phase carries
`aria-current="step"` (stable test hook); the feature chip is
`[class*="TgdPipeline_feature"]`.

### Prompt templates
User-defined reusable prompts. Server (`/api/prompts`, `<agent-dir>/prompts.json`)
stores `[{id, name, body}]`. `usePrompts` is a module-level store (shared across
instances, same pattern as `useToast`) so the composer's `/` menu and the
manager modal (⌘K → Prompt templates) stay in sync. `buildSlashItems()` merges
them with the built-in `TGD_COMMANDS`; a tGD item inserts `/name `, a template
inserts its `body`. Names are slugified server-side so `/name` is unambiguous.

### Composer menus: `/` commands vs `@file` mentions
Two dropdowns share the textarea. The slash menu only opens on a **leading**
`/` (commands replace the whole input — `setValue(item.insert)`). The `@file`
menu opens on an `@` at start-of-word before the caret (`detectFileMention`,
exported from ChatInput, unit-tested): empty query lists the cwd root, `name`
hits `/api/files/search` (fuzzy, project-wide), `dir/` lists that directory;
selecting a dir drills down (menu stays open), a file inserts `@<relative> `
(quoted if the path has spaces). Don't re-loosen the slash trigger — a
trailing `/` fires during `@src/` drill-down and mid-text paths.

### Extension interactive UI and `ask_user`
`lib/web-extension-ui.ts` implements Pi's standard RPC-safe UI surface for the
browser: select/confirm/input/editor dialogs, notifications, status text,
string widgets, title changes, and editor text. Requests travel over the
session SSE stream; replies use the existing agent command endpoint with
`type: "extension_ui_response"`. Pending dialogs and persistent status/widget/
title state replay after reconnect. `setEditorText` is deliberately one-shot —
replaying it would overwrite a draft typed after the original event.

Every session also registers the `ask_user` custom tool. It accepts one to
three structured questions and returns the answers to the model only after the
user responds. Dialog outcomes are appended as `web_ui_decision` custom session
entries. The stall watchdog pauses while a decision is pending. Dialogs raised
during `session_start` degrade to their default value because no browser knows
the new session id yet; later commands, hooks, and tool calls are interactive.
Terminal component factories, custom renderers, footer/header replacements,
and raw terminal input remain unsupported and must not be reported as fully
Web-compatible.

### File-path links in chat (`lib/file-links.ts`)
Inline code that passes `looksLikeFilePath` (conservative: bare names need a
known extension; `./ ../ / ~/` prefixes qualify; optional `:line`) renders as
a clickable link in MarkdownBody. Clicks broadcast over a CustomEvent bus
(`requestOpenFile`/`onOpenFileRequest`) because MarkdownBody is many layers
below AppShell, which resolves relative → active cwd, verifies via
`?type=meta` (toast on 404), and opens the viewer tab.

### Git worktrees (`lib/worktrees.ts`, `/api/worktrees`)
`git worktree list --porcelain` parsed by `parseWorktreePorcelain` (unit-
tested); prunable and missing-on-disk checkouts are filtered server-side.
The ProjectSwitcher fetches worktrees for the top ~8 known projects on open,
nests **linked** checkouts under their project row (branch chip,
`data-testid="worktree-row"`), and dedupes their flat rows — but never the
main checkout (it IS the project; excluding it blanks the whole list).

### Project switcher (`components/sidebar/ProjectSwitcher.tsx`)
CwdPicker is now just the sidebar trigger button
(`data-testid="project-switcher-trigger"`, ⌘/Ctrl+P) + the modal, portalled
to `<body>` (`data-testid="project-switcher"`). One input, two modes:
default = fuzzy search over pinned/recent projects (from the `projects`
prop), nested worktrees, and repos from `GET /api/projects/discover`
(shallow `~` scan for `.git` dirs, 60s cache on globalThis); a leading `/`
or `~` flips to path mode — dir completion via POST `/api/cwd/browse`,
`Tab` completes the highlighted dir, `↵` commits the typed path through
`/api/cwd/validate`. Pins/hidden keep the old localStorage keys
(`pi-cwd-pins`/`pi-cwd-hidden`). `useCwd`'s `dropdownOpen` is reused as the
modal's open state; its outside-click handler is inert (dropdownRef is no
longer attached) — the modal closes itself via overlay mousedown/Esc.

### SSE connect-before-prompt
`connectEvents(sid)` returns a promise that resolves on `onopen` (1.5s
safety-net timeout) and **reuses** an already-open EventSource for the same
session instead of tearing it down. The prompt/bash send paths `await` it —
POSTing before the stream is open loses the run's first events. Keep that
ordering.

### Two kinds of branching — don't confuse them
- **Fork**: new independent `.jsonl` file; shown as a child via
  `parentSession` header (display metadata only — safe to rewrite files).
- **In-session branch**: `navigate_tree` within one file; switching loads
  `/api/sessions/[id]/context?leafId=`.

### Edit-and-rerun a past turn
`UserMessageView` inline editor → `handleEditRerun(prevEntryId, newText)` in
`useAgentSession`: `navigate_tree` back to the entry before the turn, then send
the edited text as a fresh branch. Same primitives as `handleRetry` (which does
the last turn, unedited).

### ToolCall field normalization
Pi stores `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses
`{toolCallId, toolName, input}` — `normalizeToolCalls()` handles both file
load and streaming paths.

### /api/git security
Both routes gate `cwd` against the session allowed-roots set, use `execFile`
(no shell), reject `-`-prefixed paths, and cap at 1 MB. Keep it that way.

### i18n
`lib/i18n.tsx`: add keys to `MESSAGES`, use `t()` in components /
`translate()` in non-reactive code. English is the default locale; zh-TW is
partial (config modals intentionally untranslated). Palette actions carry
Chinese `keywords` so both languages can search them.

### CSS Design Tokens (`app/globals.css`)
Semantic tokens with light/dark + per-skin variants. `chrome-mono` class =
JetBrains Mono for machine-y labels (group headers, stats, meta); message
content stays Inter.

### Bundled fonts (`public/fonts/`, `@font-face` in `globals.css`)
Latin: **Inter** (400/500/600/700) + **JetBrains Mono** (400/700). CJK:
**Noto Sans TC** (400/500/700, CJK-only subset ~7MB total) so Traditional
Chinese renders with TC glyphs on every OS — without it, Linux/Windows fall
back to a Simplified-default or bitmap system font (e.g. WenQuanYi) and draw
Han codepoints with the wrong regional shapes. The `@font-face` blocks carry
a CJK `unicode-range` so Latin/digits stay on Inter; the sans + mono stacks
list `'Noto Sans TC'` ahead of the system CJK names. Regenerate the subset
with `pyftsubset <full-NotoSansTC-weight>.ttf --unicodes=U+3000-303F,U+3400-4DBF,U+4E00-9FFF,U+F900-FAFF,U+FE30-FE4F,U+FF00-FFEF --flavor=woff2`
(full-weight TTFs come from the `@expo-google-fonts/noto-sans-tc` npm package).

---

## Pi Session File Format

Location: `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"...","modelId":"...","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],"stopReason":"stop|error|aborted","errorMessage":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"bashExecution","command":"...","output":"...","exitCode":0}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
{"type":"session_info","id":"...","parentId":"...","name":"user-defined name"}
```

`entryIds[]` in `SessionContext` is a parallel array to `messages[]` — maps
each displayed message back to its `.jsonl` entry id, used for fork and
navigate_tree calls.
