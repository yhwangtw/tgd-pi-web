# Durable conversations: usage and limits

Pi Web offers an explicit **Durable (preview)** mode for new conversations. It
uses the official `@earendil-works/pi-durable` package, pinned to **1.0.0**. Upstream
describes this runtime as experimental. The Web integration is implemented in
this source tree; this document does not claim a release or production deployment.

New Standard conversations remain Standard. Older JSONL conversations automatically
convert when the user next sends a prompt while they are idle.

## Choosing a mode

| Entry point | Selection | Execution and scope |
| --- | --- | --- |
| New conversation | Open **More composer controls** and select **Durable (preview)** before the first message | Native Durable chat, branches, Goal/Plan, subagents, MCP, questions and the Pi extension bridge |
| Schedule Center | Choose **Resume after restart (experimental)** when creating or editing a schedule | The same Durable conversation host, with the schedule's saved execution settings and deadline |
| Agents → New run → Execution, model and tools | Choose **Resume after restart (experimental)** | A separate background runner for selected file/shell tools; it does not load the conversation's workflow, MCP or question extensions |
| Temporary conversation | Enable temporary mode alongside Durable | The conversation stays in MemoryStorage; it cannot survive a server restart |

The mode selector applies to a new conversation, not an in-place conversion of
an existing session. The API equivalent is `engine: "durable"` when creating a
chat or schedule; omitting it retains the existing default.

Use the normal composer, stop button, model/tool controls and branch actions.
`/goal` and `/plan` use the same Web controls and text widgets; their state is
stored in the Durable conversation. A pending question remains an inline card
and can be answered after reconnecting. Closing or deferring the card does not
approve it.

## Automatic conversion of older conversations

Sending the next prompt converts an eligible old conversation before admitting that
prompt. Opening a bookmark, browsing the list, searching or exporting does not
convert it. New conversations explicitly created in Standard remain Standard.

Conversion preserves the original JSONL byte-for-byte and saves its full tree in
SQLite, including branch IDs, labels, custom entries, hidden messages, summaries,
model and thinking settings. The official SDK reconstructs the selected branch's
model context. Historical tools are imported as recorded messages, never executed.
Goal/Plan state is restored; an active Goal starts paused and can be resumed through
the existing Goal control. This does not invent checkpoints for old executions.

A verified receipt in `<agent-dir>/session-migrations/` redirects the old ID to the
new `dw_` identity. Old bookmarks and API URLs continue to work. The list hides the
retained source, and pins, tags, archives and read markers follow the new identity.
Deleting a converted conversation does not reactivate its source backup.

Busy sessions, pending questions or queues, active background ownership, corrupt or
unsupported history, missing models, unfinished tool calls, and verification errors
retain Standard mode and display a reason when the prompt is sent. Conversion can
retry on a later idle continuation. Publication occurs only after history checks
and an unchanged-source check; concurrent requests share one conversion and prompt
receipts prevent duplicate native runs. Only future Durable work gets checkpoints.
An external Pi CLI must not write the retained source after cutover; later JSONL
edits are not merged into SQLite.

## What is connected

| Capability | Current behavior |
| --- | --- |
| Chat and recovery | Streams through the existing SSE interface; saved submissions use stable request IDs, and reconnect snapshots rebuild the visible conversation |
| Branches | Each branch has its own conversation identity inside the same harness/store; branching preserves its source history and pauses inherited workflow execution |
| Goal and Plan | Persisted native documents and hooks handle progress, continuation, configured budgets, pause/stop and plan tool restrictions |
| Subagents | Native child conversations/tasks support single, parallel and chain delegation, cancellation and saved results; parent tools and configured budgets constrain children. Native children appear in the Agents panel, where their conversation/activity can be opened or cancelled; retry them through the owning parent |
| MCP | Reuses Pi Web's connection manager and registration rules, including current configuration, schemas, output checks, timeout and cancellation; remote tools default to unsafe replay |
| Questions | `ask_user`, `select`, `confirm`, `input` and `editor` save their pending state and answer receipts; duplicate identical answers are accepted, conflicting answers are rejected, and deadlines survive reopening |
| Pi extensions | An ExtensionRunner bridge supports commands, prompt preparation, context/tool hooks, lifecycle events, custom entries and the existing Web UI adapter |
| History tools | Session listing, context inspection, search, analytics, rename, delete, clone and Markdown/HTML export understand Durable sessions; export credential filtering also handles the HTML's encoded transcript |
| Schedules | Saves the admitted run's prompt/model/tools and request ID; a restart reconnects unfinished work, including pending questions, with the original deadline |

Goal, Plan and subagent integration remain Pi Web-maintained code using official
Pi APIs. They are not unmodified official extension packages. The legacy Pi
runtime stays pinned separately; the `pi-ai-durable` npm alias supplies the
Durable 1.0 model contract while `lib/durable-models.ts` uses the existing model
configuration and authentication runtime.

## Storage and recovery

Persistent conversations and scheduled runs use:

```text
<agent-dir>/durable-sessions/<group>/
  bootstrap.json       host configuration needed to reopen the store
  session.sqlite       authoritative tasks, entries and documents
  <conversation>.json  derived read-only projection for the Web interface
```

One harness owns a store at a time. Branches and children are conversations in
that harness, rather than independent model loops forwarding messages through a
second legacy AgentSession. A process lease prevents concurrent owners. Recovery
of a crashed owner's lease can take several seconds.

The Web uses `dw_<group>_<conversation>` identifiers for this path. Directories
and saved files are private to the server account. The derived JSON projection
is not a Pi JSONL session and is not a substitute for the SQLite store. A missing
projection is reported as unavailable by history reads, not as completed work.

Reading the session list, searching, inspecting saved history or exporting it
does not resume model work. Reconnecting the conversation's event stream or
sending a command can resume unfinished execution. The scheduler reconnects its
own unfinished runs on startup. Explicitly stopped, cancelled or completed work
does not become a new run merely because the server restarts.

Questions commit their answer before acknowledging it to the browser. If an
acknowledgement is lost, submitting the same answer retrieves the saved receipt.
Host commands must reuse their saved question identity when they continue.
Closing the harness for recovery preserves a pending question; explicitly
cancelling work closes its pending questions instead.

Durable background tasks use the separate
`<agent-dir>/durable-runs/<run-id>/` runner. See its
[implementation details](DEVELOPMENT.md#durable-background-runs-experimental).
Neither runner can execute while the server is offline; persistence enables
continuation when it is running again.

## Compatibility and limits

- **JSONL is preserved.** Eligible old sessions convert on continuation with a retained
  source backup. Importing a JSONL file first opens its full tree in the standard
  reader; continuing that imported conversation can then convert it. The original
  Durable conversation and imported file are retained.
- **Extensions are a compatibility surface.** The bridge exposes a read-only
  SessionManager projection and supported host actions. Extensions that directly
  mutate session internals, require a terminal UI or assume the complete legacy
  AgentSession API may need adaptation. Installed packages have not all been
  individually verified. Extension `newSession` and `switchSession` currently
  report an unsupported host action; use the Web's new-conversation/session
  controls instead. Extension fork uses the host adapter.
- **External effects are not exactly once.** Completed tool results are retained,
  while interrupted unsafe file/shell/MCP/extension calls are not automatically
  replayed. The model may still issue a new call. An extension that writes to an
  external service must manage its own watermark or idempotency key; a local
  receipt cannot atomically commit that external write.
- **Model requests can repeat.** A request interrupted before its durable result
  was saved may be sent again and incur usage. Configured budgets and reported
  token/cost data are not a billing guarantee, particularly for concurrent work.
- **OpenViking production is unverified.** Offline extension fixtures exercise
  memory-style context injection, stable entry IDs, capture lifecycle and saved
  watermarks. They do not contact the production OpenViking service or establish
  that its complete extension works under Durable. Earlier OpenViking tests against
  the standard Pi runtime are separate evidence.
- **Temporary means temporary.** A Durable temporary conversation writes no
  persistent store. Closing the server loses its history and pending work.
- **This is not an OS sandbox.** Tool permissions and trusted-workspace behavior
  retain the server's existing boundaries. Choosing Durable does not add another
  approval flow or restrict the server account's filesystem permissions.

## Implementation and verification references

The current implementation lives in
[`durable-chat.ts`](../lib/durable-chat.ts),
[`durable-session-store.ts`](../lib/durable-session-store.ts),
[`durable-workflow.ts`](../lib/durable-workflow.ts),
[`durable-subagents.ts`](../lib/durable-subagents.ts),
[`durable-mcp.ts`](../lib/durable-mcp.ts),
[`durable-questions.ts`](../lib/durable-questions.ts) and
[`durable-extension-host.ts`](../lib/durable-extension-host.ts).

Integration tests use real Harness/SQLite with the official offline faux model:

- [Chat host](../lib/__tests__/durable-chat.test.ts) and
  [session API routes](../lib/__tests__/durable-session-routes.test.ts): saved
  prompts, reconnects, branches, read-only closed history and actual CLI export.
- [Questions](../lib/__tests__/durable-questions.test.ts) and
  [MCP](../lib/__tests__/durable-mcp.test.ts): reopen/answer receipts plus real
  local MCP subprocess, schema, abort and timeout behavior.
- [Workflow](../lib/__tests__/durable-workflow.test.ts),
  [subagents](../lib/__tests__/durable-subagents.test.ts) and
  [extension bridge](../lib/__tests__/durable-extension-host.test.ts): native
  tasks/documents and SDK extension contracts with isolated fixtures.
- [Schedule runner](../lib/__tests__/schedule-runner-native.test.ts) and
  [background runner](../lib/__tests__/durable-agent-run.test.ts): their separate
  restart and settlement contracts. The background runner's unsafe-tool crash
  probe uses a real child-process SIGKILL; ordinary close/reopen tests should not
  be described as equivalent crash coverage for every feature.

These references describe what is exercised, not a permanent passing-test count
or a claim that every provider, third-party extension or production endpoint has
been tested. The [pre-integration audit](DURABLE-INTEGRATION-AUDIT.md) retains the
earlier investigation and its dated results. Normal project testing and release
policy continue to apply; this preview adds no mandatory release ceremony.
