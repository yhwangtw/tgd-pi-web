# Impeccable readability and motion repair

Date: 2026-09-28

## Resolved defects

- Raised secondary text contrast across the six light/dark palettes. The
  design-system audit now checks muted/dim text on the opaque message, panel,
  selected, hover and elevated surfaces against 4.5:1.
- Fixed Glass phone sidebars showing the conversation through the session list.
  Both Original and TRAE now use an opaque palette surface when the sidebar
  replaces the conversation. Desktop and tablet Glass surfaces retain their
  existing treatment.
- Replaced the global near-zero animation override with scoped motion tokens.
  Reduced motion stops spatial transitions, indefinite loops and drag ripples
  while preserving short color/opacity feedback. It adds no global transitions.
- Welcome text renders as a complete phrase under reduced motion, stops its
  typing/caret timers, responds to preference changes and hydrates deterministically.
- Latest, message/turn navigation and file-line jumps read the current motion
  preference before scrolling. Reduced motion uses an immediate jump to the same
  destination; regular motion retains smooth navigation.

## Verification

All browser tests used a separate production-build candidate, isolated fixture
data and Chromium. No production service or provider-backed agent run was used.

- 35 unit tests passed across welcome typewriter, transcript scrolling,
  ChatWindow scrolling and design-system contracts.
- 50 browser tests passed across appearance, design-audit, responsive and the new
  readability/motion suite. After the JavaScript scrolling changes, 17 relevant
  tests passed across readability/motion, transcript-follow and file-links.
  These runs cover 57 distinct browser scenarios (10 overlap).
- Readability measurements cover selected and unselected session metadata in
  six palettes, light/dark modes, Original/TRAE and 390/840/1440px viewports.
  Glass measurements sample rendered background pixels with foreground glyphs
  hidden, including gradients and composited surfaces.
- Reviewed repaired phone and desktop screenshots. No transcript bleed-through
  remains in the tested phone session lists.
- TypeScript, targeted ESLint, the design-system audit and `git diff --check`
  passed. The isolated production builds succeeded.

## Detector review and limits

The final Impeccable source scan reports 29 warnings, retained after review:

- 18 side-border findings identify quote, selection, diagnostic, diff and status
  markers. These convey product state and remain in the existing visual system.
- Four font findings identify the existing bundled Inter faces. No typeface
  redesign is included in this repair.
- One bounce-easing finding identifies an unused token; it has no current consumer.
- Six layout-transition findings identify contextual panel resizing, the inspector
  highlight and analytics bars. Their normal-mode geometry remains unchanged;
  reduced-motion mode now disables those transitions. This is not a performance
  benchmark or a claim that every transition is compositor-only.

These checks do not establish whole-product WCAG conformance or physical-device
Safari behavior. Release and deployment status must be verified separately.
