git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
# Mobile workspace context — design QA

## Reference and prototype

- Reference 1: `/tmp/codex-remote-attachments/019fa46f-03fa-7143-b0f8-2fbd31e67ba9/e0e2cd2a-2659-4fea-8ca3-4038fd8930f4/1-Photo-1.jpg`
- Reference 2: `/tmp/codex-remote-attachments/019fa46f-03fa-7143-b0f8-2fbd31e67ba9/e0e2cd2a-2659-4fea-8ca3-4038fd8930f4/2-Photo-2.jpg`
- Reference dimensions: 575 × 1280 device screenshot, including browser chrome
- Prototype: `http://localhost:30142/?session=019f6632-4f09-77a8-a2eb-3fbe013788a3`
- Prototype viewport: 393 × 852 CSS pixels, light editorial skin
- State checked: session header, session-actions popup, composer-settings popup

The supplied screenshots are defect references, not a target to reproduce. QA
therefore compares whether the reported hierarchy, spacing, and context defects
are removed while retaining the existing design system.

## Iteration 1 findings

| Priority | Finding | Resolution |
| --- | --- | --- |
| P1 | The first screen names only the session, so the active repository and branch are not visible. | Added a persistent two-line workspace identity: repository + branch/detached SHA above the session title. |
| P1 | The mobile session-action popup leaves a blank quadrant and wraps System onto a second row. | Removed the hidden BranchNavigator's empty layout item and changed the popup to a three-column 320 px grid. |
| P1 | The composer popup has weak grouping and floating icon-only controls. | Rebuilt it as a two-column labeled grid with explicit Composer, Reasoning, Tools, and Sound groups. |
| P2 | The expanded-composer value clipped at mobile width. | Added a concise mobile-only Expand/Collapse value while keeping the full accessible label. |

## Final verification

- Repository: `tGD-pi-web`
- Git state: `detached · fb55d1c`
- Session action panel: 320 × 58, all three actions on one row
- Composer settings panel: 320 × 200, contained within the 393 px viewport
- No horizontal page overflow was observed in the verified states.
- Side-by-side checks were made from the supplied screenshots and fresh in-app
  browser captures after the fixes.

Status: ready. No open P0, P1, or P2 visual defects in the requested states.

## Work log interaction — 2026-08-02

| Priority | Finding | Resolution |
| --- | --- | --- |
| P1 | Expanding a long Work log could replace its real height with the message intrinsic-size estimate, moving the transcript and making touch scrolling appear to jump. | Expanded logs now opt out of message content virtualization and preserve the transcript scroll offset across the disclosure layout change. |
| P2 | A single failed step tinted the complete Work log and nested tool rows red, overstating the scope of failure. | Failure is now communicated by the warning icon, failed count, and a thin red leading marker; detailed error output retains its error treatment. |
| P2 | The global focus outline was clipped by the Work log container and could look like a stray horizontal line. | The summary focus ring is inset so keyboard focus remains complete and visible. |

Verified at 393 × 852 and desktop widths. The expanded 8-step log retained the
same scroll offset and accepted up/down wheel gestures without changing its
scroll height.

## Ask user decision card — 2026-08-02

Source: `codex-clipboard-1107af70-19f0-4103-b47f-d680676fb273.png`

| Priority | Finding | Resolution |
| --- | --- | --- |
| P1 | The decision card and the active Follow-up/Steer composer competed for attention and consumed almost the full viewport. | The normal composer is hidden while a blocking extension dialog is pending; cancelling the dialog restores it. |
| P1 | The card inherited the chat's 1080 px wide mode, making short questions and controls visually oversized. | Decision content now caps at 760 px normally and 860 px in wide mode. |
| P2 | The custom-answer choice sat outside the option grid and became a full-width row unrelated to its sibling choices. | Custom answer is now a first-class option in the same responsive grid; its input appears directly below only when selected. |
| P2 | Header, question groups, repeated Cancel actions, and large padding created too many competing layers. | Header and group spacing were tightened, the status was reduced to a dot and compact label, and the bottom action row now carries only Continue. |
| P2 | Text glyphs were used as radio indicators. | Choice indicators now use CSS state styling with `aria-pressed` on native buttons. |

Verification:

- Desktop at 1470 × 1030: card 860 × 305; no internal form scrolling.
- Mobile at 393 × 852: card 377 × 477; no horizontal overflow or internal form scrolling.
- Choice, free-text answer, enabled Continue state, close action, light and dark tokens were exercised in the local preview.

## Short reply placement — 2026-08-02

Source: `codex-clipboard-ab07626f-d9e3-445e-a480-05e9ce5afb4f.png` and the matching 30142 conversation state.

| Priority | Finding | Resolution |
| --- | --- | --- |
| P1 | The sent-message anchor used smooth scrolling. A fast response could finish before that motion reached the target, so completion preserved the old near-bottom offset. | The send anchor is now immediate, so the run spacer always starts from the intended reading position. |
| P1 | The unread marker was recalculated whenever persisted entries changed. Its effect cleanup saved the current user entry just before the assistant entry appeared, splitting one active turn with “New since your last visit.” | The marker is initialized once per session visit and read tracking now uses stable live refs. |
| P2 | End-of-run filler previously had to compensate for an anchor that might still be moving. | The filler now only protects the already-established anchor and shrinks to the minimum required height. |

Verification:

- The rebuilt 30142 production preview no longer renders an unread separator between the 10:02 prompt and reply.
- Regression coverage proves the sent-message anchor uses immediate scrolling and short-run completion does not invoke idle bottom-follow.
- Screenshot review confirms the prompt and reply are consecutive message blocks; the next real prompt is still required to observe the dynamic anchor in the user's live session.

## Session overlays and branch state — 2026-08-02

Sources: `codex-clipboard-0e39b50e-9888-4add-afeb-ad8489628f09.png` and
`codex-clipboard-ccd59597-81c7-4b21-8971-1af283ad7d1b.png`.

| Priority | Finding | Resolution |
| --- | --- | --- |
| P1 | The System prompt was fixed inside the top bar's backdrop-filter stacking context, so transcript text, bubbles, and the minimap painted over it. | The panel is now portalled to `document.body`, uses an opaque elevated surface, and has a bounded 760 px desktop width. |
| P1 | A non-empty but linear session tree was presented as an available Branches action, opening a full-width empty row. | The menu now detects actual alternate child paths, disables Branches for linear histories, and the hidden controlled navigator refuses to mount an empty panel. |
| P2 | The System prompt had no local heading or close control and read like transcript content. | Added a compact panel header, explicit close action, scroll-bounded content, and 44 px mobile close target. |

Verification:

- Unit tests cover linear and genuinely branched session trees.
- Responsive Playwright coverage confirms the dead branch action is disabled,
  the System panel is attached directly to `body`, and it stays inside the
  viewport at desktop and mobile widths.
- Fresh 30142 captures: `artifacts/system-panel-layering-fixed.png` and
  `artifacts/system-panel-layering-fixed-mobile.png`.

## Export labels — 2026-08-02

| Priority | Finding | Resolution |
| --- | --- | --- |
| P1 | `HTML` and `Markdown` did not disclose that selecting either item immediately downloads a file. | The requested `HTML` / `Markdown` primary labels are retained; each secondary line now begins with `Downloads` / `點擊即下載`, while the parent action says `Choose export format` / `選擇匯出格式`. |
| P2 | Traditional Chinese export strings mixed `session`, English punctuation, and technical shorthand. | Replaced them with task-oriented Taiwanese Traditional Chinese: `匯出對話`, `保留排版，用瀏覽器閱讀`, and `適合編輯或貼到其他工具`. |

Verified through i18n unit coverage and the desktop/mobile session-action E2E flow.

## Cross-surface accessibility and responsive repair — 2026-08-11

### Source evidence

- Audit report: `/tmp/tgd-pi-web-audit-20260811.W4UKnH/report.md`
- Reference captures: `/tmp/tgd-pi-web-audit-20260811.W4UKnH/screenshots/`
- Compared states: desktop chat/minimap, Attention, Explorer, Models, Skills;
  mobile Explorer, Models, Skills, Appearance, Analytics, and file actions.
- Post-fix captures: `/tmp/tgd-pi-web-qa-20260811.RxlVPj/`

The reference captures are defect evidence rather than a replacement visual
direction. Original/TRAE geometry, the active palette, typography tokens, and
existing product hierarchy were preserved.

### Implementation paths

- `components/chat/ChatMinimap.tsx` and `.module.css`
- `components/layout/AttentionPanel.tsx`
- `components/sidebar/FileExplorer.tsx` and `.module.css`
- `components/modals/ModelsConfig.tsx` and `.module.css`
- `components/modals/SkillsConfig.tsx` and `.module.css`
- `components/layout/AppearancePanel.tsx` and `.module.css`
- `components/layout/AppShell.tsx`
- `components/modals/AnalyticsModal.tsx` and `.module.css`
- `components/layout/TextFileViewer.module.css`
- `lib/i18n.tsx`

### Iteration history

| Iteration | Finding | Resolution and visual check |
| --- | --- | --- |
| 1 | Minimap dots and Models/Skills rows were unnamed or generic clickable elements. | Converted them to native, named buttons. `agent-browser` exposed unique minimap labels and button roles for every navigation row. |
| 1 | The Attention push action used the cryptic `♧` glyph. | Replaced it with localized `Push` / `推播` text and a complete accessible state label. |
| 1 | Explorer repeated the same @ action on files and directories; mobile showed a distracting @ column. | Limited inline mention to files, added the filename to every label, removed it from directory rows, and hid the redundant inline shortcut on mobile while retaining the context-menu action. |
| 1 | Models and Skills stacked independently scrolling list/detail panes on phones. | Replaced the stack with a list → detail drill-in and an explicit Back control, leaving one active scroll surface. |
| 1 | Appearance looked modal but left the workspace interactive. | Added a backdrop, focus entry/restore and Tab containment, `aria-modal`, body scroll lock, plus `inert`/`aria-hidden` on the app shell. |
| 1 | Analytics clipped columns on phones. | Reflowed table rows into labeled metric cards; all measured table containers now have equal client and scroll widths at 320 px. |
| 1 | File actions overlapped the mobile navigation. | Anchored the sheet above `--mobile-nav-height` and the safe-area token. Download now ends at y=773 in an 844 px viewport, above the navigation. |
| 2 | The monthly date label wrapped after the table repair. | Added no-wrap numeric labels and rechecked the 320 px analytics layout. |

### Final verification

- Browser: `agent-browser`, local development build at port 30142.
- Viewports: 1440 × 900, 840 × 900, 390 × 844, and 320 × 700 CSS px.
- Width checks: document scroll width equals viewport width at 840 and 320;
  Analytics data cards measure 288–290 px client/scroll width at 320.
- Modal checks: Appearance reports `inert: true`, `aria-hidden: true` on the app
  shell, initial focus on Close, and only modal controls in the accessibility tree.
- Explorer checks: zero directory mention controls; file controls have unique
  `Insert @ mention: <filename>` labels; no inline mention control is visible on mobile.
- Models/Skills checks: one pane at a time on mobile; list and detail states were
  clicked, scrolled, and captured; 840 px retains the desktop split layout.
- Minimap check: named turn buttons were clicked and navigated the transcript.
- File action check: Download is visible and fully above the bottom navigation.
- Console: no page errors; only React development and Fast Refresh messages.
- Static/test evidence: TypeScript passed with `--noEmit --incremental false`,
  targeted ESLint passed, `git diff --check` passed, and Vitest passed 93 files / 413 tests.

final result: passed
---

# Output Design System — Design QA

## Reference and implementation evidence

- Source visual: `/Users/elon/.codex/generated_images/019fa46f-03fa-7143-b0f8-2fbd31e67ba9/exec-e50dfdd4-83a0-4738-93d7-da6bf06e0330.png`
  - Native size: 1487 × 1058
- Desktop implementation: `design-qa-desktop.jpg`
  - Browser viewport: 1440 × 1024
- Mobile implementation: `design-qa-mobile.jpg`
  - Browser viewport: 390 × 844
- Tested state: assistant response with explanatory prose, collapsed Work log, semantic result block, and collapsed technical details.

## Full-view comparison

The implementation preserves the reference hierarchy: normal conversational prose remains primary, execution evidence is summarized in a compact Work log, the verified outcome uses one semantic result block, and raw commands/logs stay behind progressive disclosure. The result block is intentionally part of the reading flow rather than a floating dashboard card.

The surrounding Pi Web shell remains the real application shell. No raster assets were introduced for the output surface; status and disclosure affordances use the existing Lucide icon library.

## Focused-region comparison and iteration history

1. First comparison found a repeated bold outcome sentence inside the result block and insufficient emphasis on the opening summary paragraph (P2 visual hierarchy).
2. The grammar and fixture were revised so the semantic block has one outcome title only. The opening summary now uses weight 600.
3. Post-fix desktop evidence shows the intended sequence without repetition: summary → explanation → Work log → result → technical details.

## Detailed checks

- Typography: bundled Inter/Noto Sans TC stack retained; output title and summary use 600 weight; code values remain on the mono stack.
- Spacing: the Work log sits between explanation and result; result content uses a consistent 12/16 px rhythm and a semantic left rule.
- Color: all result/info/warning/error treatments use semantic CSS tokens, so Original/TRAE geometry and every palette remain compatible.
- Responsive layout: at 390 px, the result block measures x=14 to x=376 and the document scroll width equals the 390 px viewport.
- Interactions: Work log expands and collapses; technical details expands and collapses; both preserve layout position.
- Accessibility: the result is a labelled region; disclosures are native buttons/details with keyboard semantics; icons are decorative where the text already conveys meaning.
- Console: no browser warnings or errors in the verified desktop/mobile state.
- Automated coverage: Output Design System Playwright E2E 2/2; Vitest 434/434; TypeScript and ESLint clean.

final result: passed
