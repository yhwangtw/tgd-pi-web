# Subagents in Pi Web

Pi Web loads **pi-subagents 0.81.0**, a community package maintained at
[nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents), directly.
Its MIT-licensed package is pinned in package.json/package-lock.json; the Web host
does not copy its scheduler or replace its execution engine. Pi core remains 1.3.0.

## Model-driven delegation

With the subagent tool enabled, the parent model decides when delegation helps.
The package provides the tool descriptions, agent discovery, packaged skills and
prompt shortcuts. Merely installing it does not force every message to spawn a
child. Models can choose a role/model, run a child, compose dependent work, inspect
status, steer or resume with an explicit follow-up message.

Version 0.81 uses named/scripted workflows for composition; old top-level
`tasks`/`chain` inputs are no longer accepted. For example:

```json
{"workflow":"parallel","args":{"tasks":[{"agent":"scout","task":"Inspect the API"},{"agent":"reviewer","task":"Review the changed tests"}]}}
```

Use `async: false` for foreground execution. Background execution uses upstream's
default and detached runner. The parent remains loaded while upstream reports
live work or a pending completion wake, even if no browser tab is subscribed.
The Web does not force a model-provider selection for every child.

## Scope, limits and recovery

- Parent tool selections are registered through upstream's public capability
  ceiling API and refreshed before execution. Children cannot widen that ceiling.
- Existing positive Pi Web `subagentLimits` cannot be translated into equivalent
  upstream hard turn/cost/time caps. Loading the new extension fails with an
  explicit compatibility diagnostic while those values remain set; new model
  calls and Web RPC launches also check them. Values are preserved. Review and
  intentionally reconcile those settings before adopting the new execution
  engine; the Web never silently clears them.
- The Agents panel's manual queue concurrency and legacy child-limit controls
  still apply to their original execution paths. Upstream has its own config and
  budget semantics; a tool-call budget is not a turn cap, and its usage-budget
  launch check is not a hard cap on already-running model responses.
- The dashboard reads upstream's bounded async status snapshots for loaded and
  cached parent sessions. It is not a complete inventory of every persisted job.
  Missing hosts and truncated snapshots are labelled; stale results cannot be
  controlled. Foreground fleet keys are not treated as cancellable run IDs.
- Stops use an owner-validated native async ID. Acknowledgement is shown as a
  pending stop until upstream reports a terminal state. Snapshot-only cards do
  not offer a fabricated retry: ask the owning parent to resume with a follow-up.
- Parent conversations use the Pi SDK. Upstream child sessions and runners own
  their persistence/recovery; Pi Web does not replace that behavior with a
  separate execution engine. Interrupted unsafe calls must not be blindly
  replayed as new children.

## SDK host integration

The parent uses Pi's native SessionManager and ExtensionRunner. Upstream receives
that SDK context and manages its child sessions, workflows and detached runners.
Tool exposure is preserved for upstream model-only orchestration tools. Goal,
Plan, MCP and questions remain Pi Web integrations through official Pi APIs.
Upstream TUI-only components are not recreated as browser controls.

Pi Durable execution and its ExtensionRunner bridge have been retired. Archived
parent/child conversations can be converted into SDK JSONL sessions with the
[offline archive converter](DURABLE.md#offline-archive-conversion). Conversion
preserves history and IDs; interrupted work does not restart automatically.

## Verification

`lib/__tests__/upstream-subagents.integration.test.ts` uses the installed package,
a real SDK host, a local OpenAI-compatible test server and disposable agent
directories. It checks concurrent foreground children, detached background
control, parent tool ceilings and budget compatibility. No production models, credentials or conversations are
used. RPC, status projection and route/component regressions have separate tests.
