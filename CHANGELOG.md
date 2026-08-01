# Changelog

All notable changes to tGD-pi-web are documented here.

## [Unreleased]

### Changed
- **Pi runtime upgraded from 0.80.6 to 0.83.0.** Model discovery, API-key login, OAuth, logout, and active-session model selection now use Pi's canonical `ModelRuntime`; persisted credential changes restart idle sessions immediately and defer running sessions until the current run finishes.
- **Setup makes the Web/CLI version boundary explicit.** It reports the pinned Web runtime and installed global `pi` versions; an interactive mismatch offers an opt-in global CLI synchronization, while unattended installs only print the command and never mutate the global CLI.
- **Next.js request interception migrated from Middleware to Proxy.** The access gate now uses the Next.js 16 `proxy.ts` convention without the production-build deprecation warning.

### Added
- **OAuth flows have a tested browser bridge.** Browser login, device code, manual callback input, provider selection, cancellation, and prompt aborts share one typed token broker with regression tests.
- **Remote-access protection is layered.** Access cookies are expiring HMAC tokens, an optional independent `PIWEB_SESSION_SECRET` separates cookie signing from the password, failed logins are throttled, and explicit cross-origin browser mutations are blocked.
- **Dependency maintenance is automated and enforceable.** Dependabot groups the paired Pi packages and GitHub Actions updates; production audit now blocks every high/critical finding except the exact upstream Pi shrinkwrap advisory `GHSA-mh99-v99m-4gvg`, and fails once that exception becomes stale.

## [2026.07.11-4] (PR #51)

### Added
- **Session list keyboard navigation.** ↑/↓ roves a visible focus ring through the sidebar list (↓ from the search box drops into it) and Enter/Space opens the focused session; rows carry proper `option`/`aria-selected` semantics. Collapsed fork children are skipped automatically.
- **Session sort toggle.** A button beside the session search cycles Recent activity → Name → Message count (persisted in `localStorage`); date group headers only show in recency order, and fork children always stay chronological under their parent. Non-default modes tint the button as a reminder.

### Fixed
- **The file tree remembers its expansion per project.** Switching project A → B → A used to collapse the whole tree; expanded dirs are now kept per cwd for the life of the page (`lib/tree-expansion-memory.ts`).
- **Dirs that start expanded now load their children.** Tree nodes only fetched children on click, so a dir restored as open (expansion memory, reveal-from-search into a never-opened dir) rendered an open chevron with nothing under it. Loading is now driven by open-state, not clicks.

## [2026.07.11-3] (PR #50)

### Fixed
- **Security: the access gate no longer skips API paths ending in an asset extension.** The middleware matcher excluded any URL ending in `.png/.jpg/.svg/.woff/etc` (so pre-auth CSS/fonts/images load), but that also matched `/api/files/<path>.png` — so with `PIWEB_ACCESS_PASSWORD` set, an unauthenticated caller could still read/download any image/svg/font under an allowed root, bypassing the gate. The matcher now only skips Next build internals; public assets (login, icon, favicon, manifest, `/icons/*`) are allow-listed in the middleware via `isPublicGatePath()`, and every `/api/*` route is gated regardless of URL suffix.


## [2026.07.11-2] (PR #49)

### Changed
- **Theme toggle now expands from the control you clicked.** The circular-reveal animation always had an origin parameter but no caller passed one, so it always grew from the screen center. The rail button and the Appearance-panel light/dark buttons now originate the reveal at the button (via a shared, keyboard-safe helper that uses the control's center, so Enter/Space activation doesn't start it from the corner). Reduced-motion and no-View-Transitions fallbacks are unchanged.


## [2026.07.11-1] (PR #48)

### Added
- **Commit from the Changes panel.** A message box + **Commit all** button (Cmd/Ctrl+Enter) stages everything and commits via a new `POST /api/git/commit`; each changed file gets a hover **discard** button (revert a tracked file to HEAD, or remove an untracked one). Empty messages and empty commits are refused. No more dropping to bash mode to save a round of work.
- **Wake / reconnect resync.** Mobile browsers freeze background tabs and drop the SSE stream — coming back used to leave the transcript frozen (a finished run never reconnected) or missing the messages that arrived while away. On `visibilitychange`->visible (after being hidden >=3s) and on `online`, the session reloads to backfill missed messages and the stream reconnects if a run is still live.


## [2026.07.10-7] (PR #47)

### Added
- **File management in the explorer.** Right-click any file/folder (or empty space) for **New file**, **New folder**, **Rename**, **Delete** (with a confirm), and **Upload here** — plus **drag-and-drop upload** onto the tree. New `POST`/`DELETE` on `/api/files/<path>` (create/rename/upload/remove), name-validated (`lib/file-name.ts`) and gated by the same allowed-roots check as reads; deleting a project root is refused. Previously the only way to touch files from the web was bash mode.
- **Explorer knows what you're viewing.** The file open in the right panel is highlighted in the tree, and each editor tab has a **Reveal in explorer** action (right-click) that expands its ancestors and scrolls it into view.
- **Better editor tabs.** Middle-click closes a tab; right-click for **Close / Close others / Close all**; drag to reorder.
- **Image zoom & pan.** The image viewer supports wheel-zoom (up to 8x), drag-to-pan, and double-click / a badge to reset — no more downloading a screenshot to read the details.


## [2026.07.10-6] (PR #46)

### Added
- **Transcript images open in a lightbox.** Attachment thumbnails were unreadable, especially on a phone — clicking one now opens a full-screen viewer (Esc / backdrop click / × to close).
- **Each session remembers its scroll position.** Switching sessions used to always jump to the bottom; the transcript now restores where you left off (within the page load), while sessions you left at the tail keep opening at the tail. Includes a guard so the position isn't clobbered with a bogus "at bottom" reading when the pane unmounts.

## [2026.07.10-5] (PR #43–#45)

### Added
- **Composer drafts and sent-history persist per session.** Typed-but-unsent text used to live only in memory — a refresh, crash, or session switch ate it. Drafts now save to localStorage (debounced, per session, cleared on send, 64KB cap) and restore when you come back; the ArrowUp sent-message history survives reloads the same way.
- **Installable as a phone app (PWA).** `app/manifest.ts` (standalone display) + generated icons (192/512/maskable + apple-touch) — "Add to Home Screen" now opens pi-web full-screen without browser chrome. Viewport gains `interactive-widget=resizes-content` so mobile soft keyboards shrink the layout instead of covering the composer, plus `viewport-fit=cover` for notched screens.
- **Esc Esc stops the run.** Pressing Escape twice within 600ms while streaming aborts the agent (single press shows a hint toast, so a stray Esc can't kill a run). Open mention/slash menus keep their Escape behavior.
- **Code-shaped pastes are auto-fenced.** Pasting 4+ lines that look like code (indentation pattern or code tokens) wraps them in ``` so the transcript's markdown render stops mangling them; prose and short pastes are untouched.

### Fixed
- **Context-nearly-full banner and follow-up queue now align with the composer.** Both banners used symmetric `px-4` padding while the composer reserves an extra 36px on the right for the minimap rail — they stuck out past the input box's right edge (most visible on mobile). They now mirror the composer's exact geometry (`pl-4 pr-[52px]` + centered max-width), so the boxes sit flush.
- **Context-nearly-full banner no longer breaks on narrow screens.** The warning above the composer used a bare `truncate` on a flex child — `min-width: auto` means it never shrinks, so on narrow layouts the text collided with the Compact button and the percentage was clipped mid-digit. The prose now truncates properly (`min-w-0 flex-1`, full text in the tooltip) and the **percentage sits outside the truncating span** so the key number is always visible.

## [2026.07.10-4] (PR #42)

### Added
- **Extensions management panel.** New rail button (puzzle icon) + ⌘K entry opens a per-session view of everything pi's extensions registered: slash **commands**, custom **tools**, CLI **flags** (boolean flags toggle live, string flags edit inline via the runner's `setFlagValue`), and the directories they loaded from. Crucially it surfaces **load diagnostics** — a broken extension file used to fail silently in the web UI; its parse/load error (from the resource loader) plus command/shortcut collisions now show in a banner. A **Reload** button restarts the in-process session, re-discovering extensions/skills/prompts from disk without touching the transcript. New `GET/POST /api/agent/[id]/extensions`.
- Note: pi 0.80.x has no MCP support, so there is nothing MCP-related to manage yet; the panel covers what the agent actually loads.

## [2026.07.10-3] (PR #40–#41)

### Added
- **Optional access password (front-door lock for remote use).** pi-web has no accounts and can run bash, so exposing it beyond localhost was unsafe. Set `PIWEB_ACCESS_PASSWORD` and a `middleware.ts` gate now guards every route — unauthenticated page loads redirect to a `/login` page, API calls get a 401 — with an httpOnly cookie (SHA-256 of the password, timing-safe compare) that persists 30 days. Unset ⇒ gate off, local use unchanged. Log out from the Appearance panel. See `deploy/README.md`.
- **Full-text file search.** A new **Search** panel in the sidebar rail greps the selected project (ripgrep when present, bounded pure-JS fallback otherwise — no dependency assumed), groups hits by file with the match highlighted, and clicking a hit opens the file at that line in the viewer. Case toggle; new `GET /api/files/grep` reusing the existing allowed-roots security. Filename search (⌘K / `@`) is unchanged; this searches *contents*.

### Changed
- **Project picker rebuilt as a ⌘K-style switcher modal.** The old sidebar control — a faux-input path with three separate modes (list / folder browser / custom path) — is replaced by a real button (project name + path + chevron, `⌘/Ctrl+P`) that opens one modal with **one input for everything**: fuzzy search across pinned + recent projects, their **git worktrees** (nested, branch chip), and **repos auto-discovered under `~`** (new `GET /api/projects/discover`, shallow scan, cached) so the list isn't empty before any session exists; typing a `/` or `~` prefix flips the same input into **path mode** with live directory completion (`Tab` completes, `↵` uses the folder). Full keyboard nav; pins/hide carry over. The session list also gains a scope line ("`demo-project` · 4 sessions") so it's obvious the list is filtered by the selected project.

## [2026.07.10-2] (PR #39)

### Fixed
- **Export menu is usable again.** It opened *under* the tGD pipeline bar (invisible and unclickable): the top bar's `backdrop-filter` traps its stacking context — the same glass trap PR #34 fixed for the Branches dropdown, which this menu missed — and `.chatActions`' `overflow-x` clipped it besides. Now portalled to `<body>` and positioned from the button rect, same pattern as Branches.
- **Analytics no longer crashes when history contains a failed run.** An errored assistant message (e.g. a 429) records usage without `cost`; the aggregation assumed `usage.cost.*` always exists, so one such message 500'd the whole report. Aggregation moved to `lib/usage-aggregation.ts` with missing fields defaulting to zero (and no NaN pollution from partial records).

### Changed
- **Files above the 256KB text cap now open instead of erroring.** `type=read` returns the first 256KB (cut on a UTF-8 character boundary) with a `truncated` flag; the viewer shows a partial-preview banner with a download link and disables editing (saving a prefix would destroy the rest of the file).
- **HTML preview works at any size.** The preview iframe now points its `src` at a new `type=raw` streaming endpoint (inline disposition, no size cap) instead of inlining the fetched text via `srcDoc` — so big prototypes render fully even when the code view is truncated. Sandbox unchanged (`allow-scripts`, no same-origin).

## [2026.07.10-1] (PR #36–#38)

### Added
- **`@file` mention autocomplete in the composer.** Typing `@` lists the project root; `@name` fuzzy-searches filenames project-wide; `@dir/` drills into a directory (selecting a folder keeps the menu open on its contents); paths with spaces insert quoted. Arrows/Enter/Tab/Escape, same interaction as the `/` menu. Alongside this, the slash-command menu now only opens on a **leading** `/` — it used to fire on any trailing slash (so mid-text paths misfired), and commands replace the whole input anyway.
- **File paths in chat are clickable.** Inline code that looks like a file path (`src/foo.ts`, `./x`, `/abs/path`, optional `:line`) gets a quiet dotted underline; clicking resolves it against the session cwd, checks it exists (toast if not), and opens it in the right-panel viewer. Conservative heuristic — `object.property`, `and/or`, URLs and identifiers stay plain text.
- **Git worktree support.** New `GET /api/worktrees` lists a repo's checkouts (`git worktree list --porcelain`; prunable/missing filtered). The project picker nests the selected project's linked worktrees under its row with a branch chip — switching checkout is one click, and duplicate flat rows are removed.
- **Download any file.** `GET /api/files/<path>?type=download` streams with an attachment disposition; the explorer's context menu gained a **Download** entry.
- **tGD artifacts panel gained a "Files" view** that browses the *entire* `<project>-tGD/` directory as a lazy file tree — nothing hidden. The curated **Artifacts** view (per-feature docs + phase chips) deliberately omits infra like `.scans/` (the CodeGraph DB + knowledge graph) and the deep `wiki/docs/` tree; the Files tab shows all of it so you can open anything the tGD workflow wrote, including prototypes on features that don't yet have a PRD/SPEC. A segmented toggle in the panel header switches between the two (persisted). Reuses the existing file-list endpoint and viewer.

### Changed
- **pi upgraded 0.80.2 → 0.80.6.**

### Fixed
- **`~/` file links resolve against the real home directory.** They used to have the `~` stripped, aliasing `~/x` to `/x` — which could silently open a *different* existing file. The home dir now comes from `/api/home` (cached), with a toast when it can't be resolved.
- **Mention/slash menus no longer swallow IME keys.** With the `@file` or `/` menu open, pressing Enter to commit a CJK composition (or arrowing between candidates) used to be intercepted as menu navigation; both menus now ignore keys mid-composition, like the send path always has.
- **Slash-menu selection stays in range while the filter narrows** (a stale index past the end of the filtered list left nothing highlighted and made Enter a no-op), and the project picker's keyboard navigation now reaches nested worktree rows — a search matching only a worktree path also keeps its parent project visible. Bare `Makefile`/`Dockerfile`-style names in chat now link too.
- **The run's first SSE events can no longer be lost.** Sending a prompt used to tear down and recreate the EventSource and POST immediately — the run's earliest events could fire before the stream was open. `connectEvents` now reuses an already-open stream, and the send path awaits the connection (with a safety-net timeout) before prompting.
- **Completion chime plays under browser autoplay restrictions.** The chime used to create a fresh `AudioContext` at `agent_end` (no user gesture in the call stack), which starts suspended and plays silence. One shared context is now unlocked on the first user gesture and resumed before scheduling.

## [2026.07.08-2] (PR #33–#34)

### Fixed
- **Branch navigator dropdown no longer hides behind the tGD pipeline bar.** The top bar uses a `backdrop-filter` (glass), which traps `position:fixed` children in a stacking context that paints *under* the chat content — so the Branches panel opened behind the pipeline bar and was invisible. It's now rendered through a portal to `<body>` (escaping the trap) and clamped within the viewport so it never runs off the right edge on narrow layouts.
- **Top bar and tGD pipeline no longer overflow/clip on narrow screens.** The top-bar action row now scrolls horizontally instead of overlapping, the session title and live token stats hide below 640px to reclaim space, and the pipeline bar tightens its spacing and drops the "tGD" wordmark on mobile (the phase track keeps its horizontal scroll).

## [2026.07.08-1] (PR #30–#31)

### Added
- **tGD artifacts panel.** A new rail view (📄 tGD) surfaces the documents the tGD workflow writes into the sibling `<project>-tGD/` directory — `CONTEXT.md`, `TRACKING-PLAN.md`, the wiki, and per-feature `PRD.md` / `SPEC.md` / `DESIGN.md` / `TASKS.md` / `METRICS.md` + HTML prototypes. Each feature card shows which tGD phases it has evidence for (PRD/SPEC → Define, TASKS → Plan …), echoing the pipeline. Clicking any file opens it in the right panel (markdown render / HTML preview). Infra dirs (`.scans/`, `wiki/`) are excluded from the feature list. New API `GET /api/tgd/artifacts`; the `<project>-tGD` sibling is added to the file viewer's allowed roots so its docs can be opened.

### Changed
- **The tGD pipeline now reads real progress from disk, not just typed commands.** Previously a phase turned green the moment you typed its `/tgd-*` command, even if nothing was produced — and a fresh session showed all-todo despite finished artifacts on disk. Now `map`/`define`/`plan` are marked done when their artifacts actually exist in the `<project>-tGD/` dir (same source of truth as the artifacts panel), so the bar and panel can never disagree; `develop`/`verify`/`review`/`release` stay transcript-driven because they act on the code repo and leave no tGD artifact. The bar also became **feature-aware** — it shows the feature it's tracking (the one named in your last `/tgd-*` command, else the most-recently-touched feature) and reflects *that* feature's define/plan progress, instead of computing a single global sequence.

### Fixed
- **Right file-panel resize handle no longer swallows clicks on the file text.** The handle inherited `min-width: 300px` from a layout rule, so its resize hit-area was actually **300px wide** — the left third of the panel was a dead zone that hijacked text selection/clicks (worst on touch). It's now a real 9px gutter (content inset to match), and width persistence was made robust: it saves synchronously on mouseup and only when the pointer actually moved, so a plain click — or the double-click that resets the width — no longer races the save.

## [2026.07.08] (PR #18–#27)

### Added
- **Persistent tGD pipeline.** A slim always-visible bar at the top of the chat shows the seven tGD phases (Map → Define → Plan → Develop → Verify → Review → Release) and **auto-detects progress from the session transcript** — phases whose `/tgd-*` command has run show a check (done), the most recent one is highlighted (current), the rest are muted (todo). Click any phase to drop its command into the composer, so you can advance the workflow mid-session instead of only from the welcome screen. Dismissable (`×`, persisted); a `tGD ▸` chip brings it back.
- **File snapshots / restore points.** Before every agent run (each prompt and each `/tgd-*` command) the app captures a git-backed snapshot of the working tree. If a run goes wrong, expand **Restore points** at the bottom of the Changes panel and hit Restore — it reverts *only* the files that changed since that point (modified files rolled back, files created since removed, deleted files restored), leaving everything else alone. Snapshots use a throwaway git index + kept refs (`refs/pi/snap/*`), never touching your real index or HEAD; unchanged trees are deduped and the last 20 per session are kept. Git repos only. New API `GET/POST /api/git/snapshots` + `POST /api/git/snapshots/restore`.
- **Prompt template library.** Save reusable prompts and insert them by typing `/name` in the composer — they appear in the same `/` menu as the tGD commands (marked `template`) and insert their full body text. Manage them from ⌘K → **Prompt templates** (add / edit / delete). Stored server-side in `prompts.json` next to tags/pins; a shared store keeps the menu and the manager in sync live. New API `GET/POST/DELETE /api/prompts`.
- **Edit a past message and re-run.** Hover any earlier user turn → Edit turns the bubble into an inline textarea prefilled with its text; Rerun rolls the conversation back to that point (via `navigate_tree`, branching within the session) and re-sends the edited prompt. ⌘/Ctrl+Enter reruns, Esc cancels. Replaces the old "Edit from here" (which dumped the text into the bottom composer).
- **Bundled Traditional Chinese font (Noto Sans TC).** Chinese text used to fall back to a system CJK font — PingFang on macOS (fine), but on Linux/Windows often a Simplified-default Noto or a bitmap font (e.g. WenQuanYi), which draws the *same* Han codepoints with Simplified/low-quality glyph shapes. Now Noto Sans TC ships with the app (400/500/700, CJK-only subset, full ideograph coverage, ~7 MB) so Traditional glyphs render identically on every OS. The `@font-face` `unicode-range` keeps Latin/digits on Inter; regeneration steps are in AGENTS.md.
- **Skills panel shows the full SKILL.md content**, rendered as markdown (same renderer as chat) in a scrollable box under the existing Name/Description fields. New `GET /api/skills?cwd=…&content=<filePath>` returns one skill's body; the path must match a skill the resource loader actually discovered, so it can't be used to read arbitrary files.

### Changed
- **Right-panel resizer hover no longer glows accent-orange**: hovering shows a quiet neutral line; the accent line appears only while actually dragging.
- **HTML preview iframe is always white** — pages without their own background used to inherit the app's dark theme and render default-black text on a dark bg.
- **Tag filter chips (top of the sidebar) now match the session-row chips exactly**: no more gap between `#` and the name, the count badge is tinted in the tag's own hue instead of foreign gray, hover no longer jumps the chip, and the active (selected) fill uses theme-aware text — dark text on the pastel fill in dark mode instead of unreadable white. Session-row chips also gained the same 1px hue border the other chips already had. The filter row itself no longer paints its own `--bg-elev-1` background (pure white in the light skins — it showed as a stark band against the sidebar's tinted background).

### Fixed
- **`/tgd-*` commands failed with "Command not found" in resumed sessions** (fresh sessions were fine). The input handler special-cased `/tgd-*` and, for existing sessions only, routed it through `/api/agent/[id]/command` — an exact `extensionRunner.getCommand()` lookup that misses whenever the tGD workflow isn't registered under that exact extension-command name. Slash commands now always go through the normal prompt path, where pi itself resolves them (extension command → input hook → skill → prompt template → plain text), identically for new and resumed sessions.

## [2026.07.07-4] — 185bbf1 (PR #16)

### Added
- **Tool-call diff view**: expanding an `edit` tool call in the transcript renders a real red/green diff of oldText → newText (path shown above it); `write` calls render the written content as all-added lines. Other tools keep the pretty-printed JSON fallback.
- **Message bookmarks**: hover any message → ☆ to bookmark it. Bookmarks persist per session (localStorage) and appear as amber markers on the conversation minimap.
- **Session archive**: right-click a session → Archive hides it from the list without touching its file (stored in `archive.json` next to pins). A "Show archived (N)" toggle under the list reveals them; Unarchive restores. New API: `GET/POST/DELETE /api/sessions/archive`.

### Changed
- **Structural split** (no behavior change): `AppShell` (~1050 → ~770 lines) extracted `IconRail`, `ShortcutsDialog`, and `useRightPanelWidth`; `useAgentSession` (~870 → ~750 lines) extracted `use-agent-connection` (SSE wiring + stall watchdog), `use-transcript-scroll`, `use-model-catalog`, and `computeSessionStats`.

### Testing
- 3 new E2E specs (bookmarks persist across reload; archive/unarchive flow; edit/write tool diff rendering) + a tool-call session fixture — suite now 25 specs.

## [2026.07.07-3] — be38dd6 (PR #12, #13, #14)

### Performance
- **Large files render instantly**: files over 1500 lines / 150KB skip syntax highlighting by default (plain view with line numbers in content-visibility chunks — ~0.7s open vs 60s+ for forced Prism on a 3000-line file); a toolbar toggle forces highlighting when wanted. Find/go-to-line stay exact in plain mode.
- **Streaming updates throttled to ~12 fps**: markdown re-parses per SSE chunk were O(message length); now the last chunk in each 80ms window wins (flushed exactly on message end).
- **Streaming code blocks render plain** until the message completes, then highlight once (Prism was re-tokenizing the whole growing block on every chunk — same pattern Mermaid already used).
- File viewer: `SourceView` memoized, in-file find debounced 150ms, live-watch reloads debounced 300ms so agent write-bursts trigger one refresh.

### Added
- **Markdown reading polish**: GFM task lists render with styled checkboxes (no stray bullets), wide tables scroll in their own wrapper with zebra striping, `---` dividers are actually visible, nested lists sit tight, blockquotes use the accent border, and external links open in a new tab with an ↗ marker.
- The file viewer's Markdown preview now uses the same renderer as chat (math, Mermaid, highlighted code and all the fixes above included).
- **Resizable file panel**: drag the left edge (persisted as `pi-right-width`), double-click to reset to the 42% default.
- **File viewer power-ups**: in-file find with match cycling and `:N` go-to-line (highlighted + centered), copy-contents button, and **edit-in-place** — Save (⌘S)/Cancel backed by a new `PUT /api/files/<path>` (existing text files only, allowed-roots gated, size-capped; the live-watch refresh never clobbers an open editor).
- `e2e/viewer.spec.ts`: splitter drag/persist/reset, find + go-to-line, edit → save-to-disk round-trip.

### Fixed
- **Session tags were broken in both directions**: the server stores `sessionId → [tags]` but the client treated the same map as `tag → [sessionIds]` — the two keyings only agreed by accident, so chips appeared only after a reload, removal looked like it did nothing, and tag filtering broke after refresh. `useTags` now inverts the server map on load and everything client-side uses one canonical shape.
- **Tags with ≤3 entries could not be removed at all**: the inline chips had no remove control (only the overflow row did). Every chip now has an ×, and the session context menu lists current tags with per-tag removal.

### Changed
- Tag chip styling unified across the session items, the filter row, and the context menu (same pill radius/padding).
- New `e2e/tags.spec.ts` covers add → immediate chip render → remove via chip and via menu → filter round-trip.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: `YYYY.MM.DD` (date-based, aligned with upstream tGD); same-day
re-releases append `-N`. Safe for the npx flow (npm's `latest` dist-tag =
most recently published), but note `-N` counts as a semver prerelease if
anything ever depends on this package with a `^`/`~` range.

## [2026.07.07-2] — 9928c27 (PR #10)

### Added
- **In-repo E2E suite** (GitHub-only tooling: `@playwright/test` is *not* in package.json so offline/Nexus `npm ci` never tries to download browser binaries; CI installs it `--no-save`): 15 Playwright specs (chat, appearance, navigation) run against a production server with generated fixtures (`e2e/fixtures.ts` builds a real git demo project + pi session files); new CI `E2E` job with report artifact on failure. `npm run test:e2e`.
- **One-click Retry** after a failed run: rolls back to before the failed exchange (via `navigate_tree`) and re-sends the same prompt.
- **Context-pressure nudge**: at ≥80% context usage a warning banner above the input offers one-click compaction.
- **Individual queue cancel**: queued follow-ups render as separate rows, each cancellable (pi's queue clears wholesale, so removal re-queues the survivors).
- **Project picker rebuild**: searchable project list with folder name + path + session-count rows, keyboard navigation (↑↓/Enter), pin favorites and remove stale entries (persisted); **filesystem browse mode** (`/api/cwd/browse`) with breadcrumb navigation and "Use this folder"; **path autocomplete** while typing a custom path (debounced suggestions, Tab completes).
- **Deep file search**: `/api/files/search` (recursive BFS, junk dirs skipped, allowed-roots gated, capped at 200 results / depth 8); the explorer filter switches to flat server results at 2+ chars, folder hits reveal themselves in the tree.
- **Git-aware explorer**: modified/untracked files carry colored M/A/D/U badges (from `/api/git/changes`); folders containing changes show a dot.
- **Explorer context menu**: copy path / copy relative path / insert @ mention / view diff (for changed files, opens the HEAD ↔ worktree diff panel).
- **Explorer keyboard navigation**: ↑↓ move, ←→ collapse/expand, Enter opens.

## [2026.07.07] — eeacb35 (PR #6, #7, #8)

### Added
- **Glass skin** (fifth appearance): frosted translucent panels over a fixed aurora-gradient backdrop, light + dark; `⌘K → Appearance: Glass`.
- **Appearance picker**: palette button in the rail opens a glass popover with a light/dark toggle and swatch cards for all five skins (applies live on click, Esc/outside-click closes); "Open Appearance" also added to ⌘K.
- **Frosted floating chrome on every skin**: command palette, shortcuts dialog, toasts, ⌘F find bar, jump-to-bottom button, and the top bar now use backdrop-blur glass; `--glass-bg`/`--glass-border` tokens derive from each skin's palette via `color-mix`.
- **Long-message collapse**: historical messages taller than a screen clamp to a 380px preview with a fade and "Show full message · ~N lines" control; the latest exchange always renders in full; ⌘F jumps auto-expand a collapsed target.
- **Turn navigation**: ⌥↑ / ⌥↓ walk between user messages (aligned to the send-time top-anchor position); added to the shortcuts dialog together with the previously missing ⌘F row.
- **New-content counter**: while output streams and the reader isn't following, the jump-to-bottom button shows how many lines have accumulated below (`↓ +N lines`).
- **Always-follow mode**: ⌘K → "Toggle Always-Follow Output" pins the view to streaming output terminal-style; persisted (`pi-follow-stream`), default off.

### Fixed
- The transcript end marker now renders **before** the run spacer — engaging follow during a run used to pin the viewport to the spacer's blank space instead of the streaming text.
- React dev warning (and dev-overlay "1 Issue" badge) on theme switch: code blocks now pin both `background` and `backgroundColor` because the highlighter themes mix the two forms.

## [2026.07.06] — 4aa62a9 (PR #1, #2, #3)

### Added
- **Bash mode**: `!cmd` executes in the session cwd with output streamed over SSE (`bash_start/chunk/end` events); results recorded as `bashExecution` entries the agent can read; `!!cmd` excludes output from LLM context; Cancel for long runs; terminal-pane rendering with exit badges.
- **Changes panel**: git working-tree view for the session cwd (branch, per-file M/A/D/R/U status, +/− stats), refreshed after each agent turn; click-through to a HEAD ↔ worktree diff in the right panel. New `/api/git/changes` and `/api/git/file-diff` routes (allowed-roots gated, `execFile`, 1 MB cap).
- **Appearance skins**: four complete palettes — Editorial (warm paper, **default**), Terminal (emerald), Industrial (mono), Aurora (violet) — each with light+dark, switchable via ⌘K, persisted, no-flash init.
- **Attention loop**: live tab title (⏳ running / ✅ done / ⚠ failed via a React-rendered `<title>` store), browser notification when a hidden tab finishes, status line with spinner + elapsed timer, stall watchdog (60s/120s no-event warning).
- **Failure visibility**: assistant messages with `stopReason:"error"` render a red error card with the full `errorMessage`; failed runs fire an error toast, skip the completion sound, and notify as "Failed".
- **i18n**: English-default UI with a Traditional-Chinese toggle (~90 strings, `lib/i18n.tsx` module store); palette actions searchable in both languages.
- **⌘F in-conversation find**, jump-to-bottom button, input history (↑ recall), wide-chat toggle, follow-up queue banner with Cancel (`clear_queue` rpc), keyboard-shortcuts dialog with real bindings (⇧⌘M/⌘//⌘B/⌘\).
- Tests: 58 → 82 (incremental session cache, stream reducer, phase labels, run-error extraction).

### Changed
- **Layout restructure**: 44px icon rail (Sessions/Files/Changes/Search/Analytics + Models/Skills/Language/Theme) with a single contextual panel; session-scoped top bar (title + Export/Branches/System/stats); embedded file tree coexists with the full-height Files view (persisted preference).
- **Typography**: Traditional-Chinese-first font fallbacks, CJK-sized heading scale, bundled JetBrains Mono 700, antialiasing, 10.5px type floor; machine chrome set in mono (`chrome-mono`).
- **Session listing** rewritten as a stat-based incremental cache over pi's `parseSessionEntries` (no more full-disk rescans; avoids `SessionManager.open`'s file-rewrite side effect).
- `MessageView` memoized with stabilized props — streaming no longer re-renders every historical message; syntax highlighter moved to a lazy `PrismAsync` chunk.
- Scroll behavior: end-of-run only follows when the reader is near the bottom; sticky follow while streaming engages/disengages on user scrolls only; jump button uses `block:"end"`.

### Fixed
- ⌘K palette not closing after selecting a session/tag/file; mobile sidebar trapping first-time visitors; advertised-but-unbound shortcuts; `useToast` per-instance state rendering sidebar toasts invisible; cross-project selection leaving the sidebar on the old project; cwd-follow wiping the `?session=` URL param (broke reload-restore); silent send/steer/follow-up failures; "1 msgs" pluralization; search trigger collapsing to "Se…".
- CI: test job was missing entirely; lint ran the removed `next lint` under `continue-on-error` (never failed).
- `npm audit` clean via next 16.2.10 + postcss override.

## [2026.07.02] — b3d107c9

### Refactored
- **Sidebar hooks** (S1): Extracted `useSessions`, `useCwd`, `useExplorer` hooks from `SessionSidebar.tsx` (483 → 317 lines). The hooks own all session list, pin toggle, CWD picker, and file-explorer state independently. `CwdPicker.tsx` now accepts a single consolidated `state` + `actions` + `refs` object instead of 17 individual props (168 → 100 lines).
- **File API split** (F1): Decomposed the 514-line `app/api/files/[...path]/route.ts` into 3 shared lib modules:
  - `lib/file-security.ts` — path normalization, allowed-roots cache, traversal guards
  - `lib/file-mime.ts` — extension→mime/language mappings
  - `lib/file-stream.ts` — file streaming, range requests, HTML escape, docx preview wrapper
  - The route handler is now a clean dispatcher (~100 lines) that delegates to per-type helper functions.
- **useFileWatch hook** (F4): Extracted the SSE file-watch pattern from `TextFileViewer` / `ImageViewer` / `AudioViewer` into a single `hooks/useFileWatch.ts` hook. Each viewer now uses `useFileWatch(filePath)` and reacts to the returned `refreshTrigger` counter, eliminating the duplicated `new EventSource(...)` + `connected/change/error` handler boilerplate.
- **TextFileViewer 5 modes split** (F2): Split `TextFileViewer.tsx` (264 → 197 lines) by extracting three focused sub-components into `components/layout/text-viewer/`:
  - `SourceView.tsx` — syntax-highlighted source via Prism
  - `DiffViewMode.tsx` — file-change diff (wraps `DiffView`)
  - `PreviewView.tsx` — HTML iframe + Markdown render
  The parent component now dispatches by mode instead of nesting 4 ternaries.
- **formatSize consolidation** (F3): Removed duplicate `formatSize` definitions from `FileViewer.tsx` and `DiffView.tsx`; both now import the canonical version from `file-viewer-utils.ts`.
- **AppShell state extracted** (U1): Extracted 11 useState + 9 handler callbacks + 3 refs from `AppShell.tsx` (633 → 480 lines) into `hooks/useAppShellState.ts`. File tab state (right panel) extracted into `hooks/useFileTabs.ts`.
- **ChatInput controls hook** (U2): Created `hooks/useChatInputControls.ts` to consolidate the model/thinking/tool-preset prop derivations (`modelOptions`, `modelsByProvider`, `currentName`) used by `ChatInput`. The component now delegates the derivation to the hook.
- **Skeleton component** (U5): Created reusable `components/ui/Skeleton.tsx` + `Skeleton.module.css`. Replaces 3 duplicated inline `skeleton-line` placeholder blocks in `SessionSidebar`, `FileExplorer`, and `ChatWindow`. Existing call sites still use the local className — future consolidation welcome.
- **Unused imports cleaned** (5): Removed 7 truly unused imports (2× formatSize, useTheme, getRelativeFilePath, DiffView, getFileName, SkillSearchResult). Remaining 6 lint warnings are type-only false positives flagged by ESLint for `interface` types; TSC and runtime treat them as used.

### Added
- **Test coverage** (6): Added 15 new tests:
  - `lib/__tests__/agent-client.test.ts` — 6 tests covering `sendAgentCommand` success path, session-id encoding, error responses, malformed JSON.
  - `components/layout/__tests__/file-viewer-utils.test.ts` — 9 tests covering `formatSize`, `formatDuration`, `getFileExt`, `DOCX_PREVIEW_MAX_BYTES`.
  - Total: 49 tests passing (was 34).

### Verified
- TypeScript: `tsc --noEmit` — 0 errors
- ESLint: 0 errors (6 pre-existing type-only warnings, unrelated)
- Tests: `npm test` — 49/49 passing
- Dev server: `http://localhost:30141` — HTTP 200 (next dev still running)

---

## [2026.06.30] — bf0eea29

### Added
- **Session pin/unpin**: new REST endpoint `GET/POST/DELETE /api/sessions/pins` persists to `~/.pi/agent/pins.json`. Pinned sessions float to the top of the sidebar under a "Pinned" group header; unpinned sessions keep the existing tree layout with date group headers. Third sidebar action button (pin → rename → delete order, with delete still last since it's destructive). Pinned state is shown via a filled star in a neutral tone (not the warning yellow — shape, not color, signals the toggle).
- **Section dividers**: 1px `border-top` between Pinned and date groups; the first section has no divider so the layout doesn't start with a stray line.
- **`ChatInput.setText()`**: imperative API that forcefully replaces the input value. Quick-action phase chips use it so clicking a different phase swaps the slash command rather than appending.

### Changed
- **Slash command descriptions** are now uniform English em-dash format. The last command is renamed `/tgd-ship` → `/tgd-release` (the `/^/tgd-(\w+)(.*)$/` regex generalises to it automatically).
- **Brand mark unification**: "π with tGD" rendered consistently across all three sites (browser tab, ChatWindow welcome, AppShell welcome, sidebar PiAgentTitle). "π" is 28px / 700, "with tGD" is 22px / 700, baseline-aligned via flex+gap. The text "Pi" is gone from the visible UI; the Greek letter is the mark now.
- **PiAgentTitle simplified**: removed the click-to-scramble animation and click-to-show-version. The component is now a static 19-line span (was 91 lines).
- **Typography consistency**: removed `var(--font-mono)` from non-code UI chrome (ChatWindow welcome header, CwdPicker paths / items / custom-path input). Added `PingFang TC` and `Microsoft JhengHei` to the font-family fallback chain so Traditional Chinese renders correctly on macOS / Windows.

### Verified
- TypeScript: `tsc --noEmit` — 0 errors
- ESLint: 0 errors (12 pre-existing unused-import warnings, unrelated)
- Server: `http://localhost:30141` HTTP 200
- API smoke: pin/rename/delete all idempotent (GET empty, POST new, POST existing → no-op, DELETE existing, DELETE missing → no-op, POST missing id → 400), `pins.json` written to disk

---

## [2026.06.28-2] — 621efa86

### Changed
- **Lazy-load math plugins**: `remark-math` + `rehype-katex` are no longer in the initial bundle. `MarkdownBody` scans the markdown source with a `containsMath()` heuristic and dynamically imports both plugins only when `$...$` or `$$...$$` is detected. Falls back to plain rendering if plugin load fails.
- `katex/dist/katex.min.css` remains globally imported via `app/layout.tsx` (CSS payload is small, and KaTeX styles must be available before math renders).
- Added `npm run analyze` script.

### Verified (before)
- TypeScript: `tsc --noEmit` — 0 errors
- ESLint: 0 errors (12 pre-existing warnings)
- Vitest: 34/34 pass
- `next build --webpack`: ✓ 7.7s compile, 9 static pages, 23 API routes

### Bundle impact (client)
- Before lazy fix: katex / rehype-katex = **601 KB** in client
- After lazy fix: katex / rehype-katex = **0 KB** in client (now loaded only on demand)
- The 587 KB katex chunk still appears in `nodejs.html` (server-side rendering of math is unaffected)

### Code health
- `MathPlugins` type alias local to `MarkdownBody.tsx` (`{ remarkMath, rehypeKatex }`).
- `PluggableList` imported from `unified` for accurate react-markdown plugin prop typing.
- New `containsMath()` helper is regex-based and conservative (matches `$$...$$` block + `$...$` inline, avoiding `\$` escapes).

---

## [2026.06.28] — 21d61571

### Changed
- **Refactor (Batch 1 + 2)**: moved 50+ component inline `style={{}}` blocks into CSS Modules. ~4500 LOC net change across `chat/`, `layout/`, `modals/`, `sidebar/`.
- Replaced favicon with custom `app/icon.svg` (dark space + blue-purple gradient).
- AppShell: `onMouseEnter/Leave` → CSS `:hover` / `group-hover` (5 batches).

### Notes
- Semantic CSS tokens are the single source of color truth. Components contain 0 hardcoded hex/rgba.
- Tests now cover `normalize`, `file-paths`, and `session-reader` (Vitest).

---

## [2026.06.27] — bc6df39b

### Added
- Vitest test suite (3 files, 34 cases).
- `release.sh` script for date-based versioning.
- CSS hover utilities (replacing JS hover handlers).
- Bundle analyzer integration (was already configured, now exercised).

### Changed
- `ModelsConfig.tsx` split from 1639 → 803 LOC into 7 files.
- `SkillsConfig.tsx` split + modal lazy loading.
- Component directory restructured (`chat/` / `sidebar/` / `modals/` / `layout/`).
- `AGENTS.md` written for codebase onboarding.

### Fixed
- Magic color cleanup (all `hex` literals replaced with CSS tokens).
- Touch target sizes standardized (mobile).
- Send button feedback (loading + disabled states).

### Security
- ToolCall field normalization hardened (`lib/normalize.ts`).
- Error boundary added to root layout.
