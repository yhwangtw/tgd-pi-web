# Streaming delivery audit — 2026-10-23

Compared release source `0f8a31ba` with `codex/streaming-latency`, using the same
installed dependencies and shared offline fixture implementation. The original
971 baseline source files were unchanged; only the benchmark harness was added.
Production and global Pi were not used for this audit.

## Real Chromium delivery

Each engine/profile ran five prompts in one fresh precreated session. The first
prompt is excluded from warm medians; each row has four warm samples. Before and
after ran sequentially, without concurrent builds or other benchmarks. The fixture
emits 24-character chunks at nominal 2 ms intervals: 925 characters for short and
10,516 for long. All response hashes match exactly across both Web versions and
CLI. Every authoritative response and paragraph count was checked; remote HTTP
requests were blocked. Playwright transforms the shared JS generator, so its
extension-source hash differs from native Node's CLI hash; output and schedules
are identical. Browser before/after extension hashes match each other exactly.

Values are milliseconds, before → after:

| Engine / profile | First text chunk in DOM | Complete first sentence in DOM | Final marker in DOM |
| --- | ---: | ---: | ---: |
| durable / short | 122.90 → 120.85 | 122.90 → 120.90 | 122.90 → 120.90 |
| durable / long | 119.90 → 118.30 | 119.90 → 118.30 | 1154.50 → 1161.05 |
| legacy / short | 42.75 → 43.25 | 124.65 → 59.80 | 142.85 → 145.45 |
| legacy / long | 44.00 → 44.20 | 125.85 → 60.65 | 1155.75 → 1136.75 |

The standard first sentence improved by about 52%. The eager synthetic provider
already includes its first chunk in the initial SDK message, so first-chunk
latency was essentially unchanged. This does not establish a general TTFT gain.
The complete first sentence spans two chunks and exposes the old 80 ms batching
wait; the new scheduler normally publishes subsequent light updates at 16 ms.
Initial exploratory measurements waited for the full first sentence and were
incorrectly described as first text. This report names both explicitly.

Durable retains the native 100 ms progress interval. Its first chunk remains
around 120 ms, and total completion differences are small/noisy; this audit does
not claim a Durable TTFT or model throughput improvement. Neither rendering
measurement is physical display paint. Cold session creation and view readiness
are recorded separately, outside the warm Send-to-DOM medians.

## Work avoided and added cost

The transport benchmark emits 1,000 updates ending at 128,000 characters with
both SDK message and duplicated partial fields. Data bytes fell from
128,726,556 to 577,108 (99.55%). This is a synthetic cumulative stream measurement,
not a claim that every response or total request shrinks by that percentage.
The same script measured about 0.016 ms extra server encoding and 0.012 ms extra
client reconstruction per update. Full stringify and reconstructed JSON parse
remain; the replay memory budget still counts full and delta payloads.

Plain prose streaming memoizes completed Markdown paragraphs. The React parser
regression checks actual cumulative parser input under 12% of the old full-input
baseline, while final HTML remains identical. Complex Markdown falls back to
full-document parsing. No content is truncated.

## CLI boundary and remaining latency

The shared fixture also ran through bundled Pi 1.3.0 JSON CLI with a fresh isolated
agent directory and no global CLI, credentials, provider or production sessions.
Warm first JSON delta medians were 1.55 ms (short) and 2.41 ms (long). CLI cold
samples include process startup; browser samples include HTTP, app preparation
and DOM work. CLI JSON receipt is not TUI paint. Those different boundaries must
not be presented as identical performance.

The new standard host timing attributes roughly 31–34 ms before its native
provider-request boundary, including pre-run Git rollback capture. This is the
next measured candidate for optimization. Durable host output includes native
progress/checkpoint cost. First server content includes thinking/tools; client
first content means text. Client/server clocks are independent.

## Correctness evidence

- Production build, TypeScript and lint passed (three pre-existing navigation warnings).
- Full unit suite: 2,027 passed. The subsequently changed offline provider suite
  passed all nine tests, including native pre-request rejection before any delta.
- 31 browser regressions passed: reconnect/replay, final-only output, Durable
  reload/questions/branching, 780-message history, mobile output and provider recovery.
- Four opt-in browser benchmark cases passed on each source; all new live timing
  stages, DOM commits, negotiated deltas and exact final responses were checked.
- Initial JavaScript budget passed: `/` 529.4 KB gzip; limit 550 KB.
- Invalid delta bases fall back to a full snapshot once. Old clients retain full
  events. Stop waits for acknowledgment; remount/reconnect interrupts local timing
  instead of treating replay as fresh output.

Raw synthetic samples, definitions, fixture hashes, CLI outputs and wire totals:
[streaming-latency-2026-10-23.json](./streaming-latency-2026-10-23.json).
Reproduction commands are in [Development](../DEVELOPMENT.md#streaming-latency-and-incremental-transport).
