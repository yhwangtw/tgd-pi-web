# Long-session correctness and performance audit

Base: `3b607967514e306b17cf20d5bdba7b3aa2c4e14b` (v2026.10.18-1).
Changes were developed in an isolated checkout with copied dependencies. No
production sessions, dependencies or services were changed.

## Fixed

- Standard and Durable history adapters constructed a deeply nested tree. JSON
  serialization failed for a synthetic 5,000-entry chain with `Maximum call
  stack size exceeded`. This is Web integration logic, not a Pi Durable session
  count quota. New REST/SSE clients negotiate a flat indexed tree; clients rebuild
  it iteratively. No messages, labels, branches or tool results are truncated.
- Branch lookup copied each ancestor path and used recursive search. Iterative
  parent links now make lookup linear; closed menus skip active-path work.
- Assistant bubbles scanned every tool result to compute local durations. Each
  bubble now looks up only its own calls.
- Changing quote callbacks defeated historical `MessageView` memoization during
  token updates. Stable callbacks preserve memoization and quote target identity.
- Session usage and historical recovery text were rescanned on streaming renders.
  They now depend on the committed messages array. Streaming normalization happens
  after the existing 80 ms coalescing window, except immediate message-start.
- Durable sidebar/run lists repeatedly parsed complete JSON projections, including
  a second read for child runs. A stat-validated metadata cache avoids unchanged
  reads and does not retain full transcripts. Migration visibility is rechecked.
- Legacy listing scheduled all files at once. It now uses at most 32 workers and
  shares a pending scan between concurrent callers without sharing mutable results.
- SSE transport reparsed each serialized frame just to inspect its event type.
  Server-only type metadata removes that work for current clients.
- Shortcut help and Context inspector code now loads when opened.

## Evidence

Synthetic measurements on the same local Node 22 runtime; these are algorithm
and filesystem measurements, not browser or production latency guarantees.

| Operation | Before | After |
| --- | ---: | ---: |
| 3,000-node active-path lookup, median of 3 | 15.066 ms | 0.377 ms |
| 20,000-node active-path lookup | not asserted | 1.663 ms |
| 1,000 bubbles / 10,000 tool results, duration lookup | 10,000,000 scans / 349.26 ms | 1,000 lookups / 0.094 ms |
| Warm list: 80 Durable projections, 400 entries each, 33.8 MiB | 33.11 ms | 0.43 ms |
| Same listing, cold cache | 36.59 ms | 35.76 ms |
| Full projection reads over 7 warm lists | 560 | 0 |

Regression coverage includes 10,000-message Standard and Durable GET responses,
10,000-entry reconnect snapshots from both hosts, a 20,000-node JSON round-trip,
labels/roots/order, old nested payload compatibility, client REST/SSE decoding,
stream completion/replay, quote semantics, unchanged historical render counts,
cache updates/deletions/migration visibility and the 32-operation listing bound.
Tests use isolated stores and synthetic/offline provider data.

Validation: 250 suites / 1,809 tests passed; the final metadata-fetch header change
was then checked with 35 focused tests. Final production build and TypeScript
passed. Targeted lint has zero errors and two pre-existing export-navigation
warnings. Initial JavaScript is 1,790.5 KiB raw / 534.0 KiB gzip for `/`, and
1,794.1 / 535.8 KiB for `/login`, within the unchanged 1,800 / 550 KiB budgets.

## Follow-up performance implementation

The follow-up starts at local commit `6f733a66` and addresses the remaining
measured hot paths without changing production or removing history/features.

- **Cold Durable lists:** normal projection saves atomically publish a compact
  `.index.json` sidecar. Readers validate mtime/ctime/size/inode against the
  authoritative projection; stale/missing/corrupt indexes fall back safely.
  A concurrent writer cannot pair newer file identity with older metadata.
- **Durable refresh:** unchanged histories reuse conversions, context and run
  reports, and identical projections are not written again. Ordinary appended
  entries use an incremental conversion; edits, compaction, imported context and
  continuation rewrites retain the full projector. Token/usage-only batches skip
  unchanged question/workflow UI snapshots while retaining official LiveDoc reads.
- **Transport:** negotiated `flat-v2` references context messages from tree nodes
  only after exact entry-ID and structural matching. Different normalized/tool,
  usage, provider or edited messages stay inline. Native and `flat-v1` clients
  receive compatible responses. Every label, branch and message remains available.
- **Transcript:** initially mounts the latest 200 visible messages and the entire
  active turn. Earlier history loads in batches of 200. Full-history find,
  quotes, bookmarks, unread targets and Home reveal their target before scrolling.
  Real row anchors preserve prepend position; range memory accompanies scroll
  memory. Explicit navigation pauses smart follow even during prepend handling.
- **Rendering/search:** committed history elements and ref arrays remain stable
  during token frames. Find builds text/tool indexes while open, independent of
  each query. Markdown parsing reuses unchanged text. Closed model pickers build
  no option rows; model grouping uses a Map; command search indexes metadata and
  retains a stable top 50 without sorting the whole catalog.
- **Files/Git:** simultaneous root discovery, Git status and versioned preview
  reads share pending work. Completed content is not cached. Access checks,
  five-second root freshness, immediate selected-root updates, path identity and
  symlink checks remain. Directory stats are asynchronous with 16 workers; text
  prefix reads no longer block the event loop. File-watch bursts produce at most
  one media/React refresh per 100 ms, including continuous writes.
- **Startup:** agent and schedule panels join the existing lazy dialogs and
  inspector; their code downloads when opened.
- **Release cleanup:** a temporary preflight fetch previously launched detached
  Git maintenance, which could race checkout deletion and mask the actual error.
  This one command disables auto maintenance/gc, and temporary cleanup has three
  bounded retries (at most 300 ms). Caller/production Git settings are untouched.

### Follow-up evidence

Synthetic isolated measurements on local Node 22; not production browser latency.
Timings vary with host load. Operation-count regressions are in the test suite.

| Operation | Before follow-up | After follow-up |
| --- | ---: | ---: |
| Cold list: 80 Durable projections × 400 entries, 33.8 MiB | 28.01 ms / 80 full reads | 1.78 ms / 0 full reads, 52.3 KiB of indexes |
| Repeated unchanged Durable state refresh, 5 calls | full re-projection and writes | 0 history conversions / 0 context rebuilds / 0 writes |
| History conversion across 40 entries then 1 ordinary append | 81 entry inputs | 41 entry inputs |
| 10,000-message detail/snapshot JSON | 7,721,281 bytes | 4,722,391 bytes (-38.84%) |
| 20,000-message detail/snapshot JSON | 15,531,281 bytes | 9,522,391 bytes (-38.69%) |
| Initial transcript rows, 10,000-message fixture | 10,000 | 200 (except a larger active turn or restored full range) |
| 1,000-message history, 10 token-only frames | historical element traversal each frame | 0 historical row rebuilds |
| 24 concurrent cold allowed-root requests | repeated scans | 1 session scan / 2 distinct-cwd tGD checks |
| 20 concurrent same-repo Git requests | 80 subprocesses | 2 subprocesses |
| 20 concurrent versioned text reads / 12 HTML previews | duplicate work | 1 text read / 1 HTML bundle |
| Model grouping: 10,000 models / 1,000 providers | 5,004,000 comparisons / 38.113 ms | 10,000 Map lookups / 0.657 ms |
| 10,000-session command catalog, 5 warm queries | 28.424 ms | 10.335 ms |
| 100 file-watch events in a burst | one update per event | 1 update after 100 ms |
| Temporary Git fetch maintenance writers, 100 trials | 100 detached jobs | 0 jobs / 0 cleanup failures / 0 leftover checkouts |

Final follow-up validation: **260 suites / 1,872 tests passed**, including real
Git fixtures, isolated Durable stores, REST/SSE round trips and React DOM tests.
TypeScript and the production build passed. Initial JavaScript is now
**1,750.1 KiB raw / 525.5 KiB gzip** for `/`, and **1,753.6 / 527.3 KiB** for
`/login`, within the unchanged 1,800 / 550 KiB budgets. Modified-source lint has
zero errors; the two existing AppShell export-navigation warnings remain.

### Boundaries

- No production deployment or browser/native-device benchmark was performed.
  DOM scroll tests use explicit synthetic geometry; they do not prove real-device
  frame rate or layout performance.
- Existing Durable projections without sidecars still use the safe cold fallback
  until their next normal save; listing does not mutate stored conversations.
- Detail/reconnect transfers still contain complete logical history, now without
  duplicate equivalent messages. This is not server history pagination.
- Progressive DOM mounting bounds initial work, not memory or DOM after the user
  intentionally expands everything. The minimap reflects mounted history; earlier
  bookmark/unread controls and full-history search reveal older targets.
- Necessary durable commits still persist the full projection. Avoiding those
  writes would require a storage-format change; official durable work is preserved.
- Old non-negotiating tabs retain the old nested JSON depth limit until reloaded.
