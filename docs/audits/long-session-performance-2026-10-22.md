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

## Remaining scaling costs

- Cold Durable listing still synchronously parses each full projection once.
  A separately persisted compact index would remove that cost.
- Details and reconnect snapshots still transfer the whole history. Pagination
  and incremental snapshots are a future improvement; the flat format fixes
  depth, not total payload size or memory.
- Transcript DOM is not virtualized. Many messages or extreme branch fan-out
  still cost layout/render work. Any virtualization must preserve scroll anchors,
  search, bookmarks and minimap geometry; do not use `content-visibility` here.
- Durable committed-event refresh still rebuilds context and writes the complete
  projection. Token-only event batches do not rebuild the full projection, but
  awaited live/UI reads can delay event delivery under heavy load. No production
  stall was reproduced, so this audit does not claim a persistence/queue fix.
- Existing tabs use the old nested transport until reloaded. New clients accept
  both formats, while old clients keep their existing behavior and depth limit.

No browser end-to-end throughput or native device performance claim is made.
