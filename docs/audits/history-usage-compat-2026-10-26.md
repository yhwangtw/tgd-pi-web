# Historical assistant usage compatibility

A preview conversation contained an assistant reply without a `usage` field.
Pi AI 1.3 context estimation accessed `usage.totalTokens` before the next provider
request. SDK compaction-context calculation and session totals had the same
missing-metadata assumption (`totalTokens` and `input` respectively).

The postinstall compatibility guard skips absent usage in those three functions.
It preserves normal reported usage, uses the existing estimator when applicable,
and preserves unknown post-compaction context. It does not add invented usage or
rewrite historical messages. The patch targets the pinned official 1.3 packages,
is idempotent, and refuses unknown versions or function layouts.

Evidence:

- Before the fix, five of six actual-SDK regression cases failed with the same
  missing-usage exceptions. All six passed after the fix.
- Patch/version/idempotency, archive, SDK-route and HTTP-client checks: 26 passed.
- Additional usage accounting, workflow, compaction, supervisor and local
  subagent integration regressions: 79 passed.
- Typecheck, scoped ESLint, whitespace checks and production build passed.
- Thirteen relevant browser cases passed across the main and focused rerun.
  A new validation initially used an unsupported RPC command; it now checks the
  supported get_state context estimate. A mobile file fixture now waits for
  the conversation before opening Files. No product UI code changed.
- The browser continuation case now includes an actual assistant history entry
  with omitted usage and verifies state, next response, refresh and export using
  a deterministic local provider.
- Read-only validation of the reported conversation: 95 context messages estimated
  successfully; the repaired preview get_state returns finite context tokens.
  All existing entries in seven historical JSONL files match the pre-update copy.
- Updated isolated preview 30177 using its existing data directory. Production
  30141 was not restarted or modified. The user may refresh and retry the last run;
  recorded errors remain part of history.
