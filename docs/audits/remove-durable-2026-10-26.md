# Remove the Pi Durable execution path

The app now uses Pi SDK for chat, managed background runs and scheduled runs.
The upstream `pi-subagents` integration and existing SDK Goal/Plan extension remain.
There is no engine selector, automatic SDK-to-Durable conversion, Harness startup,
SQLite checkpoint runner or Durable dependency in the application.

## Historical data

`scripts/convert-session-archive.mjs` is an explicit offline archive decoder, not
an execution engine. It reads private temporary SQLite copies with Node's built-in
SQLite support, preserves historical session IDs and SDK branches, applies archived
context edits, retains native tool/image payloads, and writes standard SDK JSONL
into a new agent directory. Active goals are paused. Interrupted historical jobs
are retained without automatic replay. The original data directory is untouched.

The launcher refuses to silently hide unconverted archives. See
[the retirement and conversion guide](../DURABLE.md) before updating a production
agent directory. Existing receipts remain generic bookmark aliases.

For the local preview, three legacy conversations were converted and two existing
SDK conversations retained. All five previous IDs resolve, including original
`dw_` bookmarks. A separate backup was verified file by file before cutover.
The active preview directory contains no retired session/run SQLite directories.
Production port 30141 was not restarted or migrated.

## Acceptance evidence

- Production build completed; TypeScript and repository ESLint passed.
- Unit/component suite: 2,152 passed initially; its only failing launcher fixture
  was missing the newly imported startup guard. The fixture was repaired and
  rerun with the 11 conversion regressions: 12/12 passed. Thus all 2,153 distinct
  unit/component cases passed across the full run and focused repair run.
- Browser acceptance covered 113 distinct cases. The main run passed 109, with
  four model-recovery cases failing only because their no-inference fixture had
  not disabled idle composer suggestions. That fixture now explicitly disables
  suggestions. Its entire 13-case file passed on a fresh fixture run, including
  all four failures. No product code changed for these fixture corrections.
- Coverage includes converted bookmarks continuing through the SDK, refresh and
  export, Goal/Plan, parallel subagents and partial failure, queued follow-ups,
  Steer, scheduling UI, reconnection, unread updates, mobile controls, compaction,
  model recovery and contextual suggestions. Model execution uses deterministic
  local fixtures; this is not a live-provider reliability benchmark.
- Conversion regressions cover branch selection, archived edits, hidden shell
  output, tool results, image payloads, missing results, compaction, paused goals,
  standalone background archives, WAL-only recovery without modifying source
  files, live locks and symlink protection.
- Design token checks passed; existing translucent glass palette coverage remains
  outside the static contrast audit's certification. No visual tokens changed.
- i18n and capability-table checks passed (13 current capabilities).
- Synthetic listing: 3,000 SDK records and a 100-alias scenario passed. Warm scans
  read no transcripts. Warm medians were 53.28 ms and 68.52 ms respectively on
  this host; no claim of production/model/CLI speed equivalence is made.

Only the isolated preview on port 30177 was updated. Production deployment is a
separate action, including the explicit offline data conversion above.
