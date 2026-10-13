# Composer overlay positioning — 2026-10-13

Scope: model selector and composer Controls, preserving both existing UI styles and modeless interaction.

## Cause and correction

- Mobile pickers requested sheet presentation but inherited the shared modeless top-corner layout. Add explicit centered picker placement, retaining bottom-sheet layout on phones without making the rest of the application inert.
- The desktop model menu measured its launcher only at open time and clamped its horizontal position using a 208px assumption, regardless of actual menu width. Render the popup at the document root, measure its real size, and update on viewport, scroll, composer and ancestor resizing. Clamp to the visual viewport and select the available vertical side.
- Opening the model picker first closes desktop Controls in the same event, preventing its removal from moving a portalled option between pointer down and pointer up.

## Evidence

Baseline: isolated copy of release v2026.10.12 / 10760fb0a63bceebe3cf2bc0b9b5124991e23dbb. Four baseline layout cases failed on viewport containment or incorrect sheet placement.

Final verification:

- 35 component tests passed (composer-controls and DialogShell).
- Production build, TypeScript validation and targeted ESLint passed.
- Impeccable detector: no findings on changed UI targets.
- 27 unique Chromium browser cases passed: 10 new overlay cases plus 17 existing model recovery/streaming cases. Initial fixed run passed 23; four tests required corrected fixture assumptions (history does not imply an actively selected model; crossing to mobile can display Sessions). Those four passed on the final run without further product changes.
- Both original and trae styles; 320/390/700px sheets, short 700×430 viewport, 700/701px transition, desktop resizing/sidebar toggles with HTML preview open. Verified selection, Escape, Close/Done, focus return, draft preservation and no overflow.
- Isolated fixture data and temporary Chromium only. Model catalog/selection mocked; no real model request or production-session mutation.

Logs and screenshots: `/private/tmp/piweb-composer-layout-20261013/` (`baseline-test.log`, `fixed-test.log`, `fixed-recheck.log`, `unit-final.log`, `fixed-build.log`, `first-verification/`, `app/test-results/`).

Source changes are in the worktree. This task did not release or deploy them. Physical mobile devices and Safari were not tested.
