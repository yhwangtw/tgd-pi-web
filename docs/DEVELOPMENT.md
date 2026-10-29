# Development reference

Architecture and implementation invariants. Read the sections relevant to the change.

## Local checks and browser fixtures

Use `npm run dev` on port 30141. Stop the server using a checkout before building
there: E2E builds `.next` and starts generated fixtures on port 30177. Never build
into a running development or production checkout. Install the optional Playwright
runner in a separate tools directory, keeping its version aligned with the locked
`playwright-core`. This avoids npm re-resolving the app's installed dependency graph
(which can fail in npm 10 with a null `edgesOut`) and leaves the app manifests,
lockfile and dependencies unchanged:

```sh
E2E_TOOLS="$(mktemp -d "${TMPDIR:-/tmp}/piweb-playwright.XXXXXX")"
npm install --prefix "$E2E_TOOLS" --no-save --package-lock=false --no-audit --no-fund @playwright/test@1.64.0
export NODE_PATH="$E2E_TOOLS/node_modules${NODE_PATH:+:$NODE_PATH}"
node "$E2E_TOOLS/node_modules/@playwright/test/cli.js" install --only-shell chromium
node "$E2E_TOOLS/node_modules/@playwright/test/cli.js" test
```

`NODE_PATH` lets the config and specs resolve the isolated runner; the absolute CLI
avoids `npx` downloading or choosing another version. CI uses the same installation
with `--with-deps` for Linux browser dependencies. A preinstalled browser can be
selected with `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium`. E2E files are excluded
from the normal TypeScript/lint scope so offline installations do not need Playwright.

CI builds once, records `node scripts/e2e-build.mjs record`, then distributes
`.next` (without mutable cache/trace) to four independent jobs. Each job uses
`PI_E2E_REUSE_BUILD=1 node "$PIWEB_PLAYWRIGHT_CLI" test --shard=N/4` with the
isolated CLI path set by its install step; reuse fails on changed
source, build bytes, Node/platform or build environment, including on worker
restarts. Only mutable Next cache/trace and the exact `server/route-cache/`
response cache directory are excluded; compiled routes and prerender seeds remain
verified. Keep one worker per shard because specs share its store. On one machine, parallel shards additionally
need separate checkouts/build copies and distinct `E2E_PORT` values. Never share
`PI_E2E_RUN_ROOT` between shards. Local runs still build the full suite by default;
`PI_E2E_SPECS_JSON` accepts an explicit existing spec array, with `[]` meaning all.

JavaScript has two independent measurement scopes and gates. Both sum unique
script bodies and estimate gzip by compressing each body at Node gzip level 9;
the gzip figure is not a measurement of the server's HTTP compression.

- HTML entry: `npm run audit:js-budget` measures script sources rendered into the
  prerendered `/` and `/login` HTML, including the legacy polyfill. The gate stays
  **1800 KiB raw / 550 KiB gzip**. Its existing overrides are
  `PIWEB_MAX_INITIAL_JS_KB` and `PIWEB_MAX_INITIAL_JS_GZIP_KB`. It fails if a route
  is no longer prerendered or a referenced chunk is absent. Client-reference
  manifests contain modules from other entries and are not a route download list.
- Hydrated UI: `e2e/js-budget.spec.ts` records unique `/_next/static/**/*.js`
  responses from fresh browser pages through the Unlock button or fixture session
  becoming visible, two animation frames, and tracked script requests completing.
  This includes dynamic imports needed for that initial UI, such as the existing
  async syntax highlighter when the fixture transcript contains code. Later user
  actions are outside this checkpoint. Its independent gate is **2100 KiB raw /
  675 KiB gzip**, using only `PIWEB_MAX_HYDRATED_JS_KB` and
  `PIWEB_MAX_HYDRATED_JS_GZIP_KB`. JSON evidence records its scope, checkpoint,
  limits and chunk list. Raising this gate cannot change the HTML entry gate.

The hydrated limit was established from the 2026-10-23 fixture measurement:
2011828 raw / 637833 gzip bytes, including the existing refractor async chunk
(599617 / 215403 bytes). Read-only inspection of the production build found the
same highlighter chunk family already present (596683 / 214214 bytes); this
async dependency predates the new browser gate. The corresponding candidate HTML entry
was 1524805 / 461950 bytes. Offline build inspection does not establish an actual
production browser hydration total.

Transcript rows use normal layout because scroll restoration, disclosures and
the minimap measure their geometry. Do not add `content-visibility` to these rows:
display locking conflicts with descendant measurement and changes scroll anchors.
Long transcripts initially mount the latest 200 visible messages (or the whole
current turn when larger). The earlier-history button adds 200 at a time; find,
quotes, bookmarks, unread navigation and Home reveal older targets before moving
focus. Full data stays available for search and branching. Range memory accompanies
scroll memory; prepend compensation uses a committed row's real position, never
estimated-height placeholders. `isPrependingRef` suppresses stream following while
anchoring, and explicit history navigation pauses smart follow before scrolling.
This is progressive mounting, not a permanent 200-row cap after manual expansion.
Chat detail, branch navigation, background transcripts and reconnect snapshots use
`buildSessionTranscript`: the complete selected branch with collapsed compaction
notes. The legacy response field `context` contains this display transcript, not
model input. Pi continues to build its own compacted context; reading history
never rewrites session files or sends earlier messages back to the model.
Minimap geometry is cached between layout changes; scrolling only updates its
viewport indicator, with observer work coalesced into animation frames. Scroll
before visibility assertions for offscreen controls. UI text uses the Unicode
ellipsis (`Message…`, `Filter files…`). UI labels, model/provider display names,
status text and metadata follow `--font-ui` so the appearance preference applies
consistently. Code, paths, commands and technical identifiers retain `--font-mono`;
use `<code>` or a scoped rule for technical values inside mixed-content rows.
Use `tabular-nums` for aligned UI counters without changing their text family.

Floating `DialogShell` panels dismiss on a complete primary click/tap outside,
including modeless panels whose overlay allows background interaction. Only the
top dialog responds; child portals, internal selections and canceled gestures
stay open. `canClose` protects in-flight work and `hasUnsavedChanges` asks before
X, Escape or outside dismissal discards an edited form. Explicit Cancel buttons
remain intentional discard actions.

## Output limits and empty answers

An output ceiling limits one provider response, not the entire user's answer.
Pi Web's output recovery extension uses the official `turn_end` boundary to
append a hidden custom message and continue the same agent loop when a response
reaches its confirmed model ceiling. Distinct progressing chunks continue until
the model finishes; repeated chunks and repeated no-answer results stop recovery.
A first empty/thinking-only result gets an answer-focused continuation, using a
supported lower reasoning effort for that answer request only. Saved model,
thinking and output settings remain unchanged; compaction requests are excluded.

Defer context-clamped or premature truncation to Pi's official compact/retry path.
Abort, queued user input, model/session changes and explicit Goal limits take
priority. Hidden continuations never become another user chat message. A later
successful answer quiets earlier output-limit notices without losing partial text.
Unrecovered outcomes retain an explicit explanation and manual retry controls.
Goals judge the final response at `agent_settled`, after official recovery.

## Workflow and delegation

The empty composer can suggest a next message after a completed assistant turn.
Each suggestion is a human user's question or request addressed to the assistant
(for example, "Can you verify the mobile layout?" / "幫我驗證手機版的排版。"),
not an assistant promise such as "I'll test it" / "我會先測試". Role instructions
and conservative output checks reject obvious assistant self-reports, reusing the
bounded empty-result retry policy.
The request also carries a bounded task snapshot: an earlier user goal, the
latest three explicit corrections, read-only mode, current Goal/Plan and six
normalized execution receipts from the latest user turn. Raw commands, tool
output, images and thinking are excluded; common credentials are redacted.
When a session is already running, the server reads its SDK branch to replace
stale/hidden UI cards. This lookup never starts or resumes an agent. Missing state remains unknown. The snapshot is capped at
3,000 serialized characters and uses the same generation call (200 output tokens
for a structured hint/intent/source response). Deterministic guards reject
nonexistent sources, completed-step retries, inappropriate execution during
planning or pauses, failed-execution bypasses, repeated requests and invented consent.
Latest corrections take precedence over earlier goals in the prompt; source and
format checks do not prove semantic correctness. The latest user's Chinese/English
language is detected separately from the UI locale (including mixed file names);
entirely wrong-language hints are rejected rather than shown.
Esc rejects that generated suggestion for the current session/turn. Editing and
clearing may request a different suggestion; clearing an accepted hint restores
it from cache. Rejected suggestions are kept only in bounded memory/tab storage
(three per turn, 64 turn keys); after three rejections that turn stays quiet.
For synthetic model quality/latency comparisons, run
`node scripts/eval-composer-hints.mjs --origin http://127.0.0.1:30177 --provider <existing-provider> --model <existing-model> --output /absolute/new-report.json`.
This makes six bounded hint requests and no chat commands. Review its captured
outputs; lexical checks are not a substitute for semantic review.
Suggestions use the selected provider/model in a separate tool-free request, with
at most four visible user/assistant messages (3,000 characters total), no images,
thinking or tool output, reasoning off, up to 200 output tokens, a fifteen-second model timeout
and no SDK retries. They never alter the session or authorize actions. Tab or a click
inserts an editable draft; clearing that draft immediately restores its cached
suggestion. Escape hides it until the user edits and clears the draft or a new
turn completes. Typed drafts,
attachments, pending questions, queued messages and running/compacting turns take
precedence. Composer controls expose a persisted opt-out. Successful suggestions
have a ten-minute bounded in-memory cache. Empty output and transient failures
retry only while idle, after two then four seconds (three attempts per context/
exclusion variant), with a one-minute cooldown after exhaustion. Typing, running, switching
sessions or opting out cancels scheduled retries. Missing models/credentials and
permanent provider refusals are not retried. The API distinguishes ready, empty,
error, unavailable and busy outcomes without exposing provider error text.
Browser/server caches coalesce duplicate requests and enforce the retry budget;
each completed turn has its own cache identity, even with identical message text.
Failures retain the normal placeholder.
Background suggestions have their own small provider usage, outside the agent turn.

Goal has no fixed continuation count. `/goal --runs 50 <objective>` or
`/goal runs 50` sets one; `0` removes it. Token budgets, explicit stop/pause,
errors and repeated responses without progress still stop continuation. Reopening
the SDK runtime restores goals paused. Plan permits independent `in_progress` steps and
ordinary Markdown summaries; `structured_output` is optional. Explicit `/plan`
remains read-only until execution is requested.

Goal/Plan cards can be hidden completely and reopened from the composer toolbar.
Visibility is remembered per session, independently of changing titles or replayed
events, and never changes the task state. `/plan exit` (also `/plan cancel`)
clears the saved plan and restores its previous tools without starting a run.
Leaving the Plan tool preset also clears a planning/ready plan atomically with
the tool change; busy or queued work must settle first. Switching tools alone
keeps an executing plan's progress. A preset-only Plan with no saved prior tools
exits to the default tools; an explicitly saved empty selection remains empty.

Pi SDK chat uses the pinned community `pi-subagents` extension.
`lib/upstream-subagents.ts` loads the full factory and packaged resources, connects
its RPC client and session-liveness protocol, and registers upstream capability
ceilings from the active parent tools. `lib/upstream-subagent-runs.ts` projects
upstream status into existing Agents cards; it does not schedule or execute jobs.
The old supervisor remains for manually started background tasks and historical
runs. Its queue concurrency and legacy budget controls do not configure upstream.
Existing positive legacy subagent limits block adoption explicitly rather than
being silently discarded. See [SUBAGENTS.md](SUBAGENTS.md).

## Architecture

### SDK execution and retired Durable archives

Conversations, manual background runs and schedules use the official Pi SDK.
There is no `engine: "durable"` execution path or automatic conversion when a
conversation is continued. `lib/rpc-manager.ts` creates SDK sessions through
`AgentSessionRuntime`; `lib/agent-run-supervisor.ts` owns the manual queue, and
`lib/schedule-runner.ts` owns scheduled execution. Upstream `pi-subagents` retains
its own child execution and background-job protocol.

Manual queue jobs keep workspace trust, tool selections, model settings, limits,
stop and explicit retry. SDK sessions save native JSONL history. The activity
viewer reads a saved session or an unsaved live SDK session without starting
execution, and returns at most the latest 400 messages. A retry creates a new
run. After restart, active manual jobs become interrupted and active scheduled
jobs become failed. Legacy Durable queued/active records receive an explicit
retirement reason; they are retained and never replayed automatically.

Old stores can be converted with the one-time offline command documented in
[archive conversion](DURABLE.md#offline-archive-conversion). It creates a separate
agent directory, retains original data and preserves old `dw_` IDs as ordinary
SDK session IDs. Stop all writers and back up the source before executing it.
`lib/session-migrations.ts` retains existing bookmark aliases without selecting an
execution engine. [The pre-integration audit](DURABLE-INTEGRATION-AUDIT.md) is
historical evidence only.

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

**Session browsing** parses native `.jsonl` files via `lib/session-reader.ts`
without creating or resuming an agent. **Sending a message** uses
`startRpcSession()` in `lib/rpc-manager.ts`; `AgentSessionRuntime` owns its
new/switch/fork lifecycle.

### Layout (post-redesign)

Icon rail (44px, `AppShell`) → contextual panel (Sessions | Schedules | Files | Changes) → chat (session-scoped top bar + transcript + input) → right panel (file viewer / diff). Rail bottom: Models / Skills / Language / Theme. Global hotkeys live in one `AppShell` effect — **every hint shown in the ⌘K palette must be bound there**.

---

## File Map

```
app/api/
  sessions/…                      list/read/patch/delete, context, export(+md),
                                  search, tags, pins, analytics
  agent/new/route.ts              POST { cwd, message, toolNames?, provider?, modelId? }
  agent/[id]/route.ts             GET state | POST SDK command
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
uses monotonic content cursors. A focused, foreground transcript must expose the
bottom of a user/assistant message unobscured for 600 ms before advancing; quick
visits, background tabs, overlays and unfinished answers do not count. Scrolling
back cannot move the cursor backward. Equal timestamps use transcript order.

Read receipts are cached locally and batch-synced via `/api/sessions/reads`. The
server validates entry IDs against actual session entries and derives timestamps
and append positions itself. `session-reads.json` lives in the active agent
directory; existing session-list polls carry its snapshot across devices/origins
using that same backend. Preview and production stores remain isolated. Failed
sync preserves local progress and retries on the next list refresh; there is no
extra poller. Old browser receipts remain usable until confirmed by viewing content.

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
  marks running/waiting runs failed, including retained legacy Durable runs; it
  never reconnects or replays an interrupted execution. Missed occurrences
  follow the schedule's catch-up-once or skip policy. A schedule cannot overlap.
- Once/daily/weekly/cron calculations are dependency-free and IANA-timezone
  aware, including DST gaps/repeated minutes. Cron is the standard five-field
  form; DOM/DOW use the usual OR rule when both fields are restricted.
- A run creates a persisted Pi SDK JSONL session with the configured
  cwd/model/thinking/tools. The runner
  sends `prompt` with `awaitCompletion:true`; normal
  browser prompts remain fire-and-forget. Do not remove that distinction — an
  immediate model/setup rejection otherwise leaves a run stuck as `running`.
- Dialog requests (`ask_user`, select/confirm/input/editor) change the run to
  `waiting_for_input`. Opening its session replays the pending request; a
  keepalive prevents the SDK runtime's idle shutdown. Pending dialogs survive
  browser reconnects while the host is alive; a server restart fails that run.
- This is an in-process local scheduler: the production Node server must stay
  running for on-time execution. It is intentionally not an OS daemon.

### Run activity

- Total time uses the same authoritative run start in the dock and active work log. Individual tools use their SDK start event; absent timing is omitted instead of inferred from a message timestamp. Reconnect snapshots preserve these starts and map server/browser clock skew.
- The disclosure lists all active call IDs and accepts only the public `pi-subagents` `Details.progress` states for individual children. Unknown/unreported child states are not inferred from launch arguments. Progress metadata is bounded; it does not introduce provider calls or polling.
- Selecting a tool explicitly opens the owning work log and that call, focuses its header and pauses history follow. The request is session scoped; user toggles still control disclosures afterward.
- Quiet/reconnecting headers say “Last state”. Only an actual reconnect gets warning styling. Mobile defaults to phase, total and freshness; full targets and connection meaning are accessible in a keyboard/touch disclosure.

`RunStatus` lives outside the transcript in the composer dock, so it remains
visible while reading history. Its one-second clock rerenders only the monitor;
`lastProgressAtRef` tracks received model/tool events independently of SSE
keepalive comments, extension UI messages and latency receipts. Server snapshots
and the browser share `isRunProgressEvent`; reconnects restore the run clock.
An open connection is not proof of provider computation. Quiet status retains
the last reported phase, and active work-log summaries remain visible while
parameters, results and provider-supplied reasoning stay expandable.

### Scroll contract (ChatWindow + useAgentSession)
- On send: smart/always mode anchors a short user message in the upper quarter;
  tall messages get room for their beginning. Preserve mode reveals only what
  is needed. Immediate positioning settles after nested layout commits (two
  stable frames, four at most). A viewport-height observer corrects late composer
  reflow only until the first reply or reader input; anchoring is not mistaken
  for an upward-reading pause. A three-quarter-viewport spacer leaves reply room.
- End of run: never infer follow intent from the post-layout distance. Removing
  the viewport spacer can clamp `scrollTop` to the new maximum and make an
  anchored reader look like they were at the tail. Shrink the spacer to the
  minimum filler needed to preserve the viewport; engaged streaming follow is
  already pinned, and only explicit always-follow may move an idle reader.
- Streaming follow: engaged only by user scrolls into the bottom zone (or the
  jump button) — content growth never changes engagement. Instant scrolls,
  not smooth (smooth queues jitter at token rate).
- Jump-to-bottom uses `block:"end"` — `block:"start"` + spacer can scroll the
  conversation out of the viewport. When following, correct a tail that shifted
  above the viewport rather than leaving the reader in blank filler. Do not
  mistake that overshoot for reading earlier history; real upward input and
  navigation with the tail below the viewport still pause smart following.
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
rail view lists these documents on demand without computing phase completion.
`.scans/` and dot-dirs are infra, excluded. API: `GET /api/tgd/artifacts`.
The panel has two views (toggle persisted in `localStorage["pi-tgd-artifacts-view"]`):
**Artifacts** (the curated per-feature document view above) and **Files** — a lazy
tree of the *whole* tGD dir (nothing excluded: `.scans/`, `wiki/docs/`, prototypes),
built on the existing `GET /api/files/<abs>?type=list` endpoint (the tGD dir is an
allowed root, so its subtree lists/reads without extra wiring).

Chat sessions do not scan transcripts for `/tgd-*` commands or request the
artifact endpoint to infer workflow progress. There is no phase bar, restore chip,
or phase action row in the welcome composer. Manually invoking an available
slash command still follows the normal Pi command path.

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

File previews pause monitoring while their panel or browser tab is hidden and
reconcile on return. HTTP/2 and HTTP/3 retain SSE file-change delivery. HTTP/1
(or an unknown navigation protocol) polls only a no-store metadata revision
once a second, with one bounded request at a time. This leaves normal request
slots available when several conversations also hold agent event streams;
file contents reload only after change. The revision includes inode and ctime,
so equal-size writes and replacements preserving mtime still invalidate it.

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

Session detail requests from current clients advertise `X-Pi-Session-Tree: flat-v2`;
SSE connections use `tree=flat-v2`. Their `sessionData.tree` is a flat indexed
`{ format, roots, nodes }` payload (snapshot protocol version 2), so JSON depth
does not grow with conversation length. `session-tree-wire.ts` reconstructs the
existing tree iteratively at the client boundary. The v2 tree references context
messages only when entry IDs and complete message structures agree; transformed,
compacted or edited messages remain inline. No history is truncated. Older clients
negotiating `flat-v1` receive the original flat payload; tabs without negotiation
retain the nested version-1 format until reloaded; its historical depth limit still applies.
Do not serialize a nested internal tree on a version-2 transport path. Labels,
root order, branch order and parent IDs must round-trip unchanged.

### Streaming latency and incremental transport
Current clients additionally negotiate `stream=delta-v1`. The runtime retains
immutable full events, plus a bounded JSON-splice delta when it is smaller.
Each connection/replay starts with a full message update; snapshots and message
boundaries reset the delta baseline. Completed messages stay full and native.
A missing or invalid base triggers one cursorless snapshot reconnect and turns
off deltas for that session. Older clients keep the original full-event format.
This reduces wire bytes; both server serialization and client reconstruction /
JSON parsing still work on the full message. The replay log counts full and delta
bytes within its existing limit.

The first nonempty text, thinking, tool or image update is published immediately.
Later snapshots coalesce at 16 ms, backing off to 33 / 80 ms for long messages or
a late event loop. Completion uses the authoritative final message; session
changes cancel queued updates. Plain streaming paragraphs and ATX headings reuse
parsed blocks; context-dependent Markdown falls back to full parsing, as does the
final completed message. There is no truncation or new visual style.

Normal foreground prompts carry an ephemeral `timingId`. `run_timing` SSE frames
are live observations, excluded from the replay log and cursor deduplication.
Client diagnostics are bounded to 30 local records, with no prompt, response,
credentials, persistence or telemetry. Listen for `pi-run-latency` during a local
audit, or read terminal `performance.getEntriesByType("measure")` entries named
`pi.web.run:<id>`. Client durations start at Send handling; `requestSentMs` marks
the command boundary, `firstContentMs` means first assistant **text** received,
`firstCommitMs` means a React DOM commit with that text, and `displayLagMs` is the
difference. A DOM commit is not physical display paint.

Server durations have their own clock: `accepted`, `provider_request`,
`first_content`, `completed`. The native before-request hook is a dispatch
boundary, not proof of remote receipt. Server first content includes thinking,
tools and images and is therefore different from client first text. Never
subtract client and server clock readings.
Switching/reconnecting, including the normal new-session remount, interrupts the
local observation rather than mislabelling replay as live first output. A failed
abort does not count as an acknowledged cancellation.

Offline comparison helpers use only generated fixture data and the project's
bundled Pi version, never a global CLI or a paid provider:

```bash
node scripts/bench-stream-transport.mjs BASE_REVISION
node scripts/bench-streaming-runtime.mjs --profile short --runs 5 --output /tmp/cli-short.json
# Build an isolated candidate first; this opt-in suite starts it on port 30177.
PI_STREAM_EXPECT_TIMING=1 npx playwright test --config e2e/benchmarks/playwright.config.ts
```

The opt-in browser suite uses real Chromium, a deterministic offline provider and
exact output assertions. It measures Send click to DOM text and records session
setup separately. Its extra model does not enter the normal E2E suite. CLI cold
process startup, CLI warm JSON receipt and browser DOM time have different
boundaries; offline numbers do not prove production provider or TUI performance.

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
localized titles and descriptions, plus bilingual `keywords` so both languages
can search them.

### CSS Design Tokens (`app/globals.css`)
Semantic tokens with light/dark + per-skin variants. `chrome-mono` class =
JetBrains Mono for code, paths, identifiers and machine data. General headings,
labels and actions follow `--font-ui`; body copy uses `--type-body-size`.
Panel titles use `--type-title-size`, controls `--type-ui-size`, supporting labels
`--type-label-size`, and only incidental timestamps/counts `--type-meta-size`.
Lucide glyphs use `UI_ICON_SIZE` (12 inline, 16 compact, 18 control, 20 navigation)
and `--component-icon-stroke`; provider artwork and large illustrations are
separate. IconButton manages glyph size independently from the touch target.

### Bundled fonts (`public/fonts/`, `@font-face` in `globals.css`)
Latin: **Inter** (400/500/600/700) + **JetBrains Mono** (400/700). CJK:
**Noto Sans TC** (400/500/600/700, CJK-only subset ~9MB total) so Traditional
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

## UI audit regressions and dependency patches

`e2e/audit-regressions.spec.ts` checks narrow message actions, file-tab keyboard
navigation, session-grid and empty-state semantics, provider labels, mobile
focus restoration, persisted login language, rendered light/dark contrast,
three-pane headers, coarse-pointer minimap behavior, keyboard scrolling of wide
code and persistent Mermaid/code-focus state. It uses the same isolated
fixtures as the rest of E2E; axe checks actual rendered controls.

Keep ReactMarkdown's component renderers stable across parent updates. Recreating
the component functions unmounts code blocks and diagrams, resetting their focus
dialogs and preview state. Wide code blocks need a keyboard-focusable `pre` with
a visible focus outline so Safari users can scroll them without a pointer.

Security overrides preserve the tested Pi runtime versions. The local
[sprintf-js patch](../vendor/sprintf-js/README.md) bounds formatting allocations
because upstream has no published fix for GHSA-hp3w-g68c-fv3c. Keep its license and
regression tests when updating it. The existing postinstall patch removes Pi's
shrinkwrapped vulnerable brace-expansion copy; run normal `npm ci`, then audit
production dependencies. Runtime-center commands align an optional global CLI
with the embedded version and restore the lockfile with `npm ci` only while the
checkout's server is stopped. Web updates use the managed update center or the
release workflow.

### Pi 1.3 historical usage compatibility

The postinstall script `scripts/patch-pi-history-usage.mjs` guards absent assistant
usage in Pi AI context estimation, SDK compaction context calculation and usage
totals. Older/imported JSONL messages can legitimately lack usage. These narrow
guards skip missing billing data and preserve context estimation/unknown state;
they never synthesize usage records or rewrite session history. The patch is
idempotent and refuses unreviewed SDK versions or source layouts. Verify/remove
it when adopting an upstream fix. Regression coverage uses the actual SDK and
a browser continuation with historical usage omitted.
