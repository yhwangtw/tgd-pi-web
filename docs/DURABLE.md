# Pi Durable retired: archive conversion

Pi Durable execution has been removed from Pi Web. Conversations, manually
queued background runs and schedules now use the official Pi SDK. The Durable
mode selector, restart-resume option and automatic conversion when continuing a
conversation are no longer available.

This page replaces the retired preview's usage guide. The
[pre-integration audit](DURABLE-INTEGRATION-AUDIT.md) records historical
investigation and test results; it does not describe the current runtime.

## Current behavior

- SDK sessions use native Pi JSONL history and SessionManager lifecycle.
- The upstream community `pi-subagents` extension continues to own delegated
  child execution, workflows and background-job recovery. See [Subagents](SUBAGENTS.md).
- An interrupted manual run remains visible as interrupted. An interrupted
  scheduled run remains visible as failed. Legacy queued/active Durable records
  receive a retirement reason and are never replayed automatically. Explicitly
  retrying a manual run or running a schedule starts new SDK work.
- Browser reconnects can reconnect to a live SDK session. Restarting the server
  does not restore an in-flight model request, tool execution or pending dialog.

## Offline archive conversion

The one-time converter creates a separate SDK agent directory from an existing
agent directory. It makes no model calls and retains the original data. Back up
the source first, and stop the server, detached workers and every other process
that can write to that agent directory before executing conversion. Keep the
original directory and its matching old runtime available for rollback.

First inspect a dry run:

```sh
node scripts/convert-session-archive.mjs --agent-dir /absolute/path --output /absolute/new-agent-dir
```

Without `--execute`, the command only reports the proposed conversion. Review
that report and use a new output directory separate from the source. To write
the converted directory, run the same command with explicit execution:

```sh
node scripts/convert-session-archive.mjs --agent-dir /absolute/path --output /absolute/new-agent-dir --execute
```

Existing native SDK sessions are retained. Archived Durable conversations and
background transcripts become ordinary SDK JSONL history; old `dw_` IDs remain
normal SDK session IDs so historical bookmarks and references can still resolve.
Existing session aliases are retained. Historical run and schedule records are
kept, their retired engine flags are removed, and interrupted work is marked
without automatic replay.

Conversion does not select the live data directory or start a service. Inspect
the output and verify session history before an explicit operator-controlled
cutover. Source-only rollback and data-directory rollback are separate actions;
never point an old runtime at converted data as a substitute for retaining the
original directory. See [managed updates](MANAGED-UPDATES.md#retired-pi-durable-data)
and [release policy](RELEASING.md).
