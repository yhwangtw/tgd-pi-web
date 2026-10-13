# File browser layout and interaction — 2026-10-13

Scope: repair the existing right-side file browser, retaining original and trae styles. No release, deployment, dependency install or real-session mutation.

## Findings and changes

- Conflicting Inspector container/media rules made the 390px mobile drawer 50px too narrow. One component now owns placement: full-width bottom sheet on phones, available full height on short phones, overlay in narrow desktop panes and inline on spacious panes. Headers remain fixed while long content scrolls and wraps.
- A 320px desktop file panel split two previews into approximately 153px columns. Split orientation now follows measured panel width: stack below 720px, return to adjacent columns when expanded.
- Resizing from a wide desktop into a laptop layout did not reconsider the sidebar. Crossing the compact breakpoint now borrows sidebar space for the file panel and preserves the existing restoration behavior.
- File-tab context menus now render outside clipped ancestors, clamp to the viewport, follow resize/scroll and support keyboard opening, arrows, Home/End, Escape and focus return.
- File Info is portalled, height-bounded and can flip above its trigger. Narrow toolbars remain scrollable. Inspector long paths, notes and diagnostics cannot force the layout wider.
- Escape dismisses Info, Inspector, then file focus mode in order and respects the focused split pane. Inspector navigation reveals the selected source line, and closing restores trigger focus.
- Closed panels are inert. Tab menus unmount with the panel, and closing returns focus to the panel launcher instead of leaving it on a hidden control.

## Evidence

Isolated candidate: `/private/tmp/piweb-composer-layout-20261013/app`, based on production source `10760fb0a63bceebe3cf2bc0b9b5124991e23dbb` (v2026.10.12), with the previous composer repair retained. The working checkout contains older unrelated changes, so validation used this candidate rather than building over any running checkout.

- Baseline: 3 of 4 focused browser cases failed on mobile drawer width, split-pane width and context-menu focus. Original short-viewport Info was already passing.
- 26 unit cases passed: resize gestures/cancellation, tab menus, viewer overlays and editor lifecycle.
- 20 unique Chromium cases passed: 14 new file-browser layout cases and 6 existing preview-control cases. The first fixed run passed 17; closing-focus restoration was then added, and the short trae fixture now opens its file before shrinking the viewport. Six affected/visual cases passed on the final run.
- Browser coverage includes both styles; 320/390px phones, 700/701px transition, tablet sizes, 1440/1600/1920px desktops, 390×320 and 700×430 short viewports; mouse, keyboard and synthesized tablet touch; split/expand/restore, inspector navigation, Info, context menus, sidebar resizing and close/reopen.
- Production build and TypeScript checks passed. Targeted ESLint has no errors; two pre-existing internal-navigation warnings remain in AppShell. E2E files are excluded by the existing lint configuration.
- Impeccable detector returned no findings on changed UI targets. Reviewed narrow split, mobile Inspector and short-viewport Info screenshots.
- Pre-existing modified/untracked file hashes were compared with the task-start snapshot: only scoped files changed; none were removed. The original Inspector mobile font declaration was preserved.

Evidence directory: `/private/tmp/piweb-file-browser-20261013/` (`baseline-test.log`, `fixed-test.log`, `final-test.log`, `unit.log`, `build-final.log`, `lint-final.log`, `design-detect*.json`, and screenshot result directories).

These are isolated Chromium checks, not physical-device/Safari or authenticated-production validation. Source is repaired; 30141 and the public site have not been updated in this task.
