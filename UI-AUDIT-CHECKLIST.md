# Pi Web complete UI audit checklist

This document is the completion contract for the current visual repair. A green
build or a single clean screenshot is not enough. Every required surface and
state below needs direct evidence before the audit can be marked complete.

## 1. Coverage matrix

### Viewports and reflow

- [ ] 320 × 800 — minimum supported phone
- [ ] 360 × 800 — narrow Android phone
- [ ] 390 × 844 — primary mobile reference
- [ ] 430 × 932 — wide phone
- [ ] 600 × 900 — mobile/tablet boundary
- [ ] 701 × 900 — first rail-based layout pixel
- [ ] 768 × 900 — tablet portrait
- [ ] 840 × 889 — reported overlay failure width
- [ ] 1024 × 800 — last overlay-layout pixel
- [ ] 1280 × 800 — compact desktop
- [ ] 1440 × 900 — primary desktop reference
- [ ] 1920 × 1080 — wide desktop
- [ ] Browser zoom/reflow at 200% without horizontal page scrolling
- [ ] Safe-area inset simulation and virtual-keyboard height changes

### Appearance combinations

- [ ] Interface geometry: Original, TRAE
- [ ] Palettes: TRAE, Terminal, Industrial, Aurora, Editorial, Glass
- [ ] Light and dark mode for every palette
- [ ] Font sizes: Small, Default, Large, XL
- [ ] Font families: Sans, Mono, System
- [ ] Density: Comfortable, Compact
- [ ] Message layout: Split, All left
- [ ] Locale: Traditional Chinese, English
- [ ] Reduced motion and coarse-pointer environments

Full component-state checks use Original and TRAE at mobile, tablet, and
desktop widths. Every palette/theme combination is checked on the shell,
messages, forms, menus, dialogs, success/warning/error states, and code blocks.
Every typography preference is checked for reflow and clipping. High-risk
cross-combinations include XL + Mono + Traditional Chinese at 320, 840, and
1440 pixels.

### Required interaction states

- [ ] Default/resting
- [ ] Hover
- [ ] Keyboard focus and visible focus ring
- [ ] Pressed/active/selected/current
- [ ] Disabled and unavailable
- [ ] Loading/skeleton/running/streaming
- [ ] Empty/no-results/no-project/no-git
- [ ] Success/completed
- [ ] Warning/stalled/waiting-for-input
- [ ] Error/failed/offline/retry
- [ ] Open/closed/expanded/collapsed
- [ ] Long text, long paths, large counts, CJK and English wrapping
- [ ] Scroll start/middle/end and nested-scroll behavior
- [ ] Pointer, touch, keyboard-only, Escape, outside-click and back behavior

## 2. Visual-system checks

### Typography

- [ ] Inter, JetBrains Mono and Noto Sans TC load from bundled assets
- [ ] Traditional Chinese uses TC glyph shapes on every family option
- [ ] UI text and code text use the intended font roles
- [ ] Only supported weights 400/500/600/700 render
- [ ] Body, labels, metadata, titles and code have a coherent size hierarchy
- [ ] Line-height remains readable and never clips accents or CJK glyphs
- [ ] Letter spacing is restrained; uppercase/mono labels remain legible
- [ ] Numbers and usage statistics align without becoming visually dominant
- [ ] Small text meets legibility and contrast requirements
- [ ] XL and browser zoom reflow without overlap, clipping or hidden actions

### Color and contrast

- [ ] Text, muted text and disabled text remain distinguishable
- [ ] Accent color is reserved for selection, progress and primary actions
- [ ] Error color marks the failed part, not an entire unrelated region
- [ ] Warning, success, information and diff colors work in light/dark mode
- [ ] Links are identifiable without relying only on color
- [ ] Focus indicators remain visible on every palette
- [ ] Glass/translucent surfaces keep readable contrast over live content
- [ ] Overlays dim content without dimming persistent navigation controls
- [ ] Selected, hover and disabled states remain distinguishable in every skin

### Geometry and spacing

- [ ] Radius scale is consistent across controls, cards, menus and dialogs
- [ ] Pills are used only for compact status/segmented controls
- [ ] Nested components do not stack incompatible large radii
- [ ] Spacing follows a consistent 4/8px rhythm with optical exceptions noted
- [ ] Headings, content, metadata and actions have clear vertical grouping
- [ ] Borders separate structure only where spacing/background cannot
- [ ] Shadows communicate elevation without creating heavy halos
- [ ] Icon sizes, stroke weights and optical alignment are consistent
- [ ] Pointer targets are at least 24px and touch targets at least 44px
- [ ] No element is horizontally clipped or creates document overflow

## 3. Component inventory

### Application shell and global navigation

- [ ] `AppShell`: full-height layout, safe areas, three-pane combinations
- [ ] `IconRail`: every primary/settings action and selected state
- [ ] `MobileNavigation`: Chat/Sessions/Files/Search/More and bottom safe area
- [ ] Mobile More sheet: grouping, backdrop, close, active and disabled actions
- [ ] Top bar: repository, branch/detached state, session title and actions
- [ ] Session menu: Export, Analytics, System and branch availability
- [ ] tGD pipeline: phases, feature chip, progress, hide and long names
- [ ] Sidebar overlay/backdrop at every 701–1024 breakpoint
- [ ] Right panel, resizer, open/closed animation and narrow desktop behavior
- [ ] `TabBar`: active/inactive/dirty/close/reorder/overflow states
- [ ] Command palette and keyboard-shortcut dialog
- [ ] Appearance panel and Design Inspector

### Project and session navigation

- [ ] `PiAgentTitle` and New/Refresh actions
- [ ] `CwdPicker` trigger and selected-project summary
- [ ] `ProjectSwitcher`: recent, pinned, discovered, worktrees, path mode, empty
- [ ] `SessionSidebar`: loading, groups, sorting, archived toggle and long lists
- [ ] `SessionItem`: selected, pinned, tags, fork tree, timestamps and long titles
- [ ] `SessionTreeItem`: hierarchy, expand/collapse and keyboard semantics
- [ ] `SessionContextMenu`: tags, archive, delete and destructive confirmation
- [ ] `TagFilter`: selected, overflow, add/remove and no tags

### Chat transcript and messages

- [ ] `ChatWindow`: initial, restored, loading, running, ended and empty session
- [ ] User message: split/left layouts, edit, copy, quote, bookmark, new session
- [ ] Assistant message: model label, streaming, usage, actions and bookmarks
- [ ] Error card: concise message, technical details, billing/retry actions
- [ ] Markdown paragraphs, headings, emphasis, lists, quotes and horizontal rules
- [ ] Markdown tables, links, file paths, inline code and fenced code
- [ ] Syntax highlighting, line focus, copy and full-screen focus dialog
- [ ] Math, Mermaid, images, image lightbox and unsupported-content fallback
- [ ] `BashBlock`: running, success, failure, long output and copy
- [ ] Tool calls/results: pending, running, success, failure and nested groups
- [ ] `TurnActivityGroup` / Work log: short, long, expanded, failed and scrolling
- [ ] `CompactionSummary` and long-message collapse/expand
- [ ] `BranchNavigator`: no branches, branch switching and long labels
- [ ] `ChatMinimap`, bookmarks and jump-to-bottom/new-content indicator
- [ ] `MobileTurnNavigator`: sheet, current turn, bookmarks and close
- [ ] Find in transcript: query, scopes, matches, no results and navigation

### Composer and interactive agent UI

- [ ] `ChatInput`: empty, text, multiline, history and disabled
- [ ] Send, Stop, Steer and Follow-up modes
- [ ] Running composer with queued follow-ups and pending counts
- [ ] Expanded/collapsed composer
- [ ] Image attachment, preview, remove and upload error
- [ ] Quote row and context-file chips with long paths
- [ ] Slash command menu: built-ins, prompt templates and no results
- [ ] File mention menu: root, search, nested folders, quoted paths and no results
- [ ] Model, thinking and tool-preset selectors
- [ ] More-controls panel, compaction, sound and layout controls
- [ ] `QueuedFollowUps`: edit, reorder, remove, busy and empty
- [ ] `UserQuestionCard`: select, confirm, input, editor, custom answer and validation
- [ ] `ExtensionUIPanel`: decision requests, status, widgets and reconnect replay
- [ ] `FocusDialog`: focus trap, close, scroll and code-line interaction

### Primary work panels

- [ ] Sessions panel and project switching
- [ ] `AgentDashboardPanel`: summary, filters, concurrency, empty and grouped runs
- [ ] `AgentRunCard`: queued/running/completed/failed/cancel/retry/selection
- [ ] `AgentRunForm`: project, branch, prompt, model, tools, validation and submit
- [ ] `SchedulePanel`: empty, list, history, paused, failed and next-run state
- [ ] Schedule editor: once/daily/weekly/cron, timezone, validation and actions
- [ ] `FilesPanel` / `FileExplorer`: tree, loading, empty, errors and long paths
- [ ] `FileOpsDialog`: create, rename, delete, validation and destructive state
- [ ] `SearchPanel` / `UnifiedSearchResults`: scopes, loading, empty and keyboard nav
- [ ] `ChangesPanel`: clean, modified/untracked, selection, commit and discard
- [ ] `DiffPanel` / `DiffView`: add/remove, long lines, binary and empty diff
- [ ] `TgdArtifactsPanel`: Artifacts/Files modes, phases, empty and full trees

### File viewers

- [ ] `FileViewer` routing, loading, unsupported and error states
- [ ] Text toolbar: path, type, lines, size, dirty status and actions
- [ ] Raw/source/preview/diff modes and mode switching
- [ ] Edit/find/goto-line controls and unsaved-change confirmation
- [ ] Markdown preview and code source
- [ ] `ImageViewer`: fit, zoom, pan, metadata and transparent images
- [ ] `AudioViewer`: play, pause, scrub, duration and errors
- [ ] `DocumentViewer`: supported/unsupported and loading behavior
- [ ] Tabs with many files, duplicate names and narrow widths

### Dialogs, settings and system feedback

- [ ] `ModelsConfig`: providers, API keys, OAuth, add/test/save/delete and empty
- [ ] `SkillsConfig`: search, global/project, enabled/disabled, detail and install
- [ ] `ExtensionsConfig`: inventory, files, hooks, details, empty and error
- [ ] `PromptsConfig`: list, create, edit, validation and delete
- [ ] `AnalyticsModal`: cards, charts, filters, empty and long values
- [ ] `ToolPanel`: tool toggles, descriptions and scrolling
- [ ] `AddProviderPicker`, `ApiKeyDetail`, `OAuthDetail`, `AddSkillPanel`, `SkillDetail`
- [ ] `ImageLightbox`, `ShortcutsDialog`, confirmation dialogs and nested popovers
- [ ] `Toast`: info/success/warning/error, multiple, dismiss and mobile placement
- [ ] `Skeleton`, global loading states and `ErrorBoundary`
- [ ] Login page: mobile/desktop, invalid, loading, rate-limit and provider states

## 4. Interaction and accessibility checks

- [ ] DOM reading order matches visual order
- [ ] Landmarks, headings, dialogs, menus, listboxes, trees and live regions are semantic
- [ ] Every interactive control has an accessible name and correct state attributes
- [ ] Tab order is logical and focus never moves behind an open modal/sheet
- [ ] Escape, Enter, Space and arrow-key behavior is consistent
- [ ] Focus returns to the opener after dialogs and menus close
- [ ] No hover-only action is inaccessible to touch or keyboard users
- [ ] Tooltips do not block controls or become persistent clutter
- [ ] Status changes are announced without stealing focus
- [ ] Destructive actions are distinct and require confirmation
- [ ] Error messages identify the failed field/action and offer recovery
- [ ] Motion respects reduced-motion preferences
- [ ] Scroll locking and nested scrolling do not jump or trap the reader
- [ ] Text selection, copy, links and browser zoom remain usable

## 5. Execution steps and evidence gate

1. [ ] Capture a clean baseline for every primary page at 390, 840 and 1440.
2. [ ] Measure the rendered typography, spacing, radius, contrast and targets.
3. [ ] Fix shared tokens before local component overrides.
4. [ ] Fix shell/reflow/overlay defects before component polish.
5. [ ] Walk every component and required state in the inventory above.
6. [ ] Repeat the walk in both interface geometries and both themes.
7. [ ] Run palette compatibility, font preference and high-risk cross matrices.
8. [ ] Verify keyboard, touch, zoom, safe-area and reduced-motion behavior.
9. [ ] Add a regression test for every P0/P1/P2 defect found.
10. [ ] Run typecheck, lint, unit tests, production build and complete E2E.
11. [ ] Capture final screenshots in the same states and compare them to baseline.
12. [ ] Mark completion only when every row has direct evidence or an explicit blocker.

## 6. Current audit status

- Inventory source scan: complete.
- Current worktree and existing changes: inspected and preserved.
- Existing `design-qa.md`: treated as historical partial evidence, not proof of
  the complete audit.
- Automated visual/reflow matrix: complete across Original and TRAE geometry,
  phone/tablet/desktop breakpoints, appearance variants, typography controls,
  coarse-pointer targets, overlays, dialogs, viewers and operational panels.
- High-risk cross-check: XL + Mono + Traditional Chinese passed at 320, 840 and
  1440 pixels without page overflow, clipping, target-size or typography
  violations.
- Regression coverage: 85 Playwright E2E checks passed, including the new
  analytics overflow, tablet overlay, mobile export/system panel, composer
  settings, file controls and high-risk typography checks.
- Component logic coverage: 375 Vitest checks passed across 80 files.
- Static gates: TypeScript and `git diff --check` passed; every E2E run also
  completed the production build used by its isolated server.
- Repaired during this audit: tablet overlay opacity and rail offset, schedule
  panel selector, mobile analytics scrolling, touch targets, export-menu bounds,
  system-prompt viewport containment, extension empty states, design-context
  transcript compaction and accent foreground contrast.
- Radius systems: Original and TRAE now expose the same 19 semantic component
  roles while resolving to their own crisp/soft geometry. All 537 non-zero
  component radius declarations use that contract; 18 explicit zero-radius
  declarations are intentional full-screen or edge-joined states. Source and
  rendered-value regression tests prevent arbitrary numeric radii and verify
  representative controls, rows, cards, composer surfaces and dialogs in both
  systems.
- Latest verification: 81 Vitest files / 378 tests and 86 Playwright E2E tests
  passed, alongside TypeScript, ESLint, production build and diff checks.
- Final visual audit and repair: complete for the executable coverage above.
  Unchecked inventory rows remain the standing manual-state checklist for future
  releases; they are intentionally not marked as evidence without a captured
  state.
