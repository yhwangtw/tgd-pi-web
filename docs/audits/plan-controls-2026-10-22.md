# Goal / Plan controls verification — 2026-10-22

## Change

- Hidden workflow cards leave no composer-area placeholder. The main toolbar
  keeps small, labelled Goal/Plan icons for reopening them.
- Visibility is session-scoped and survives title changes, replay and reload.
  Old title-hash preferences migrate to booleans; no task content is persisted.
- Explicit Plan exit restores tools and clears saved Plan state. Selecting a
  non-Plan preset also clears a planning/ready plan in both runtimes.
- Pending commands remain guarded across hide/reopen and session switches.
  Exiting never executes a plan or resumes a paused Goal.
- Durable exit withdraws an unsubmitted Plan receipt left by an interrupted
  command. Empty previous tool selections remain empty; legacy saved Plan
  selections recover to the default tools.

## Verification

- 208 targeted tests across 10 suites passed: UI/command hook 74, agent-session
  and transcript integration 45, Standard/Durable workflow tests 89.
- TypeScript, changed-file ESLint, production build and diff checks passed.
- Native Chrome desktop: hide Goal and Plan, reload while hidden, reopen from
  the toolbar. Generic extension status/widget remained visible.
- Native Chrome responsive viewport at 320px: hide, reopen and exit Plan;
  actions remained reachable and wrapped within the available width.
- After the browser exit, API readback showed the prior active tools restored;
  persisted Plan was null, Goal stayed paused, and message count stayed at 8.
- Browser checks used generated, disposable fixture sessions on loopback 30177.
  The fixture service was stopped afterward. No production restart, release,
  remote push or deployment was performed.
