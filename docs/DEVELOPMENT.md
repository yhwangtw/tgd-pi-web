# Development reference

Architecture and implementation invariants. Read the sections relevant to the change.

## Local checks and browser fixtures

Use `npm run dev` on port 30141. Stop the server using a checkout before building
there: E2E builds `.next` and starts generated fixtures on port 30177. Never build
into a running development or production checkout. Playwright is installed ad hoc
with `npm i -D --no-save @playwright/test`; a preinstalled browser can be selected
with `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium`. E2E files are excluded from the
normal TypeScript/lint scope so offline installations do not need Playwright.

Transcript rows use normal layout because scroll restoration, disclosures and
the minimap measure their geometry. Do not add `content-visibility` to these rows:
display locking conflicts with descendant measurement and changes scroll anchors.
Minimap geometry is cached between layout changes; scrolling only updates its
viewport indicator, with observer work coalesced into animation frames. Scroll
before visibility assertions for offscreen controls. UI text uses the Unicode
ellipsis (`Message…`, `Filter files…`).

## Workflow and delegation

Goal has no fixed continuation count. `/goal --runs 50 <objective>` or
`/goal runs 50` sets one; `0` removes it. Token budgets, explicit stop/pause,
errors and repeated responses without progress still stop continuation. Reopening
a standard runtime restores goals paused; Durable resumes saved state when work
is explicitly resumed (see [recovery semantics](DURABLE.md#storage-and-recovery)). Plan permits independent `in_progress` steps and
ordinary Markdown summaries; `structured_output` is optional. Explicit `/plan`
remains read-only until execution is requested.

Subagents default to no artificial time/turn/cost cap (`0`). Saved user budgets
remain authoritative. The model can allocate smaller per-task `limits` and narrow
`tools`; it cannot raise configured caps or enable a tool absent from its parent.
Workers inherit active parent tools, including MCP/extensions, except `subagent`.
Custom agent frontmatter can set `inheritTools: true`, or name tools explicitly.
Read-only built-ins retain their inspection-only selection. Every delegated run
uses an exact custom tool selection so runtime defaults cannot add tools back.

A configured cost cap is shared by one single/parallel/chain invocation, including
retries and later chain steps. It is checked after reported assistant usage;
already-running responses can exceed the remaining budget, especially in parallel.
Unreported provider cost cannot be enforced. A user extending a running member
also extends its shared cost cap; model-supplied allocations cannot do so.

## Architecture

### Durable conversations and schedules (preview)

The current integration is documented in [Durable usage and limits](DURABLE.md).
The [pre-integration audit](DURABLE-INTEGRATION-AUDIT.md) remains historical evidence;
its migration checklist does not describe the implementation status today.

`POST /api/agent/new` selects the native path only for `engine: "durable"`.
`lib/durable-chat.ts` owns one official Harness per store; branches and native
subagents use conversations in that harness. `lib/durable-session-store.ts`
projects saved entries for the existing session, search, analytics and export APIs.
Read-only history endpoints do not call `resume()`. SSE reconnect and the schedule
runner can resume unfinished work. An ephemeral chat uses MemoryStorage.

Goal/Plan, MCP and questions register as native Durable extensions. The
`lib/durable-extension-host.ts` bridge runs Pi's ExtensionRunner against a
read-only SessionManager projection, without creating another AgentSession model
loop. This is a compatibility surface, not a promise that every third-party
extension works. External memory capture still depends on the extension's own
watermark/idempotency. Production OpenViking has not been exercised through this
path; the offline tests use an extension fixture for its lifecycle contracts.

JSONL imports first open in the standard runtime. Older conversations convert on
an idle prompt through `lib/durable-migration.ts`; `session-migrations.ts` publishes
the verified alias, and `durable-legacy.ts` preserves the tree and reconstructs the
selected model context. New Standard conversations carry a persistent opt-out.
They do not flatten the imported history into Durable or replace its source store.

### Durable background runs (experimental)

This is the separate Agents-dashboard runner. Its smaller tool surface is
distinct from the Durable conversation/schedule path above.

`AgentRunInput.engine: "durable"` selects official Pi Durable 1.0.0 for a new
background run. Missing `engine` preserves the normal coding-agent path.
`lib/durable-agent-run.ts` owns one Harness/SQLite database per run under
`<agent-dir>/durable-runs/<uuid>/`. A process lease prevents concurrent owners;
a crashed owner's lease can take up to 15 seconds to recover. Run directories
are private (0700), databases and the atomic display projection are 0600.

The supervisor requeues active Durable runs on boot and preserves the original
start time, budgets, model selection in the conversation, and submission ID.
`submit(requestId: run.id)` resumes the admitted submission; it does not replay
the whole prompt. Terminal runs stay terminal. A retry is a distinct new run.
The harness records every tool intent and result; only read/grep/find/ls are
marked safe to replay. Writes, edits and shell commands are never automatically
replayed after interruption. The model sees the interruption and can issue new
calls, so exactly-once admission does not imply exactly-once external effects.

`pi-ai-durable` is an npm alias of official `@earendil-works/pi-ai` 1.0.0.
`lib/durable-models.ts` bridges its chat contract to the existing Pi ModelRuntime
so credentials, custom endpoints and OAuth locking remain canonical. This
version boundary needs its regression test when either Pi version changes.
Core file/shell tools and project instructions are supported. Conversation extensions,
MCP, ask_user, subagents and Goal/Plan are not installed in this harness.

The Agent card's activity viewer reads a projection of the latest 200 committed
entries; full history remains in SQLite. GET never opens/resumes a harness.
Model errors, explicit cancellation, expired budgets and revoked workspace
trust stop execution. Interrupted model calls may be resent and billed again.
The default background-run wall-clock limit remains 24 hours; explicit limits
are honored across restarts. Code tests use Pi's official faux provider with
isolated storage, including a real SIGKILL during a side-effecting tool.

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

The diagram shows the standard runtime. **Session browsing** parses `.jsonl` files
and Durable read projections via `lib/session-reader.ts`, without creating or
resuming an agent. **Sending a standard message** uses `startRpcSession()` in
`lib/rpc-manager.ts`; `AgentSessionRuntime` owns its new/switch/fork lifecycle.
The Durable route dispatches to `DurableChat.send()` instead.

### Layout (post-redesign)

Icon rail (44px, `AppShell`) → contextual panel (Sessions | Schedules | Files | Changes) → chat (session-scoped top bar + transcript + input) → right panel (file viewer / diff). Rail bottom: Models / Skills / Language / Theme. Global hotkeys live in one `AppShell` effect — **every hint shown in the ⌘K palette must be bound there**.

---

## File Map

```
app/api/
  sessions/…                      list/read/patch/delete, context, export(+md),
                                  search, tags, pins, analytics
  agent/new/route.ts              POST { cwd, message, engine?, toolNames?, provider?, modelId? }
  agent/[id]/route.ts             GET state | POST command (standard or Durable)
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

The sidebar and command palette share one session-list store. It polls every
five seconds while the page is visible, refreshes on focus/network recovery,
and retains newly created local conversations until Pi persists them. Background
refreshes do not flash the manual-refresh indicator. The sidebar's unread dot
uses browser-local read receipts, advanced only to visible message timestamps;
receipts also synchronize across tabs and reuse older transcript entry markers.

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
  marks standard running/waiting runs failed and reconnects unfinished Durable
  runs with their original execution settings and request ID. Missed occurrences
  follow the schedule's catch-up-once or skip policy. A schedule cannot overlap.
- Once/daily/weekly/cron calculations are dependency-free and IANA-timezone
  aware, including DST gaps/repeated minutes. Cron is the standard five-field
  form; DOM/DOW use the usual OR rule when both fields are restricted.
- A standard run creates a persisted Pi JSONL session; `engine: "durable"` creates
  a Durable conversation with the configured cwd/model/thinking/tools. The runner
  sends `prompt` with `awaitCompletion:true`; normal
  browser prompts remain fire-and-forget. Do not remove that distinction — an
  immediate model/setup rejection otherwise leaves a run stuck as `running`.
- Dialog requests (`ask_user`, select/confirm/input/editor) change the run to
  `waiting_for_input`. Opening its session replays the pending request; a
  keepalive prevents the standard runtime's idle shutdown. Durable questions and
  answers survive a host restart, with the original 24-hour run deadline retained.
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
- Response scroll preference (`lib/prefs.ts`, `pi-scroll-follow-mode`) has
  three states: smart (default; follows until the user scrolls up), always
  (terminal-style sticky tail), and preserve (moves only after Jump to latest).
  The legacy `pi-follow-stream=1` migrates to always. It is exposed in the
  composer controls and as three direct actions in the ⌘K palette.

### Run outcome signals
`agent_end` events carry `messages`; `getRunError()`
(hooks/use-agent-session-types.ts) reads the last assistant message's
`stopReason`. Failures: red error card (AssistantMessageView), error toast,
⚠ title, failure notification, **no** completion sound. Quiet progress and
connection health are separate states: model waits stay neutral through 90s,
become a quiet delayed status until 180s, then show only a small caution icon
and calm copy; tool thresholds are 180s/300s. Only an SSE reconnect that lasts
at least three attempts or ten seconds uses warning emphasis. SSE heartbeat
comments do not reset the meaningful-progress clock.

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
Inline code that passes `looksLikeFilePath` and explicit Markdown file links
open the right-side viewer. Markdown destinations support spaces, Unicode and
line references; preview-document links resolve relative to that document.
`requestOpenFile` captures the source ChatWindow's cwd and session from its
DOM scope, so parallel panes do not inherit the primary conversation's cwd.
AppShell verifies via `?type=meta`, cancels superseded requests, and opens the
tab with its message origin. HTML defaults to preview; line navigation uses source.

HTML previews fetch `?type=html-preview`, which bundles local styles, CSS
imports, images, fonts and classic/ES-module scripts into data URLs. All reads
stay inside the closest allowed project root, reject symlinks, and are bounded
(8 MiB per file, 24 MiB total input, 100 files). The iframe retains an opaque
origin and blocks external resources and API calls. The preview reloads after
the watched HTML revision changes; manual reload refreshes asset-only changes.
Loading completes on the iframe's load event, with cancellation and a 15-second
timeout. Missing/unsupported assets are reported without hiding the document.

Generation timing is measured only for fully observed live replies and saved
in `pi-generation-metrics-v1` in browser storage (500 records, 90 days). Keys
include session/model/timestamp and a content fingerprint; response text is
never persisted by this feature. Storage failures fall back to memory.

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
`connectEvents(sid)` resolves only after the server's authoritative
`session_snapshot` has been reconciled, not merely on `onopen`. New sessions
use `deferPrompt` to create first, connect and reconcile, then send the prompt.
An unready stream rejects and preserves the draft instead of sending blindly.
Same-session connections are reused; epoch/sequence cursors deduplicate replay
(up to 512 events / 4 MiB per runtime), with snapshot fallback after eviction or
restart. Extension one-shot editor text never enters the replay log. Prompt and
bash paths both await readiness. Closed/idle-disposed streams are recreated;
stale fetches must not overwrite a newer snapshot or resurrect a finished run.

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
