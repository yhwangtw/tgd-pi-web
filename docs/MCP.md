# MCP connections

Open **Extensions → MCP** to add a trusted local command (stdio) or a remote
**Streamable HTTP** endpoint. The Web runtime supplies the client through Pi's
Extension API; a global Pi CLI is not required. Saving a disabled configuration
does not install a package or start its command. Enabling a local command requires
confirmation, and a one-time local test reviews the exact command before running.

## Timeouts and connection status

- The editor uses **seconds**, from **1 to 120**, with a default of **15**. The
  JSON configuration and API use integer `timeoutMs` values (1000–120000).
- Initialization and all pages of initial tool discovery share one deadline.
  Each subsequent discovery refresh and tool request has its own deadline.
  Progress notifications do not extend that deadline indefinitely.
- Opening or refreshing the center checks enabled connections. A cached success
  is reused for up to 30 seconds; an older connection receives a protocol ping.
  Status reflects the most recent check, not continuous monitoring or a guarantee
  that the next tool call will succeed. Reload the center to request a new check.
- **Not connected**, **Connecting**, **Connected**, **Disconnected**, **Error**,
  and **Disabled** are distinct. A tool's own execution error is not automatically
  treated as a broken transport.

## Shared connections versus one-time tests

Concurrent users of the same saved configuration share one initialization and
one tool discovery. Changing or disabling that configuration invalidates its
connection; a late response from the old connection cannot replace the new state.

**Test connection** uses a separate connection, even for a disabled server, and
closes it when the test finishes or fails. It does not replace the connection an
agent is using. A successful test is diagnostic evidence, not an enabled setting.

Local subprocess stderr is drained without storing or displaying its contents so
verbose logging cannot block initialization or expose credentials in diagnostics.
Cleanup waits for the owned child process; after graceful shutdown fails, the SDK
escalates to termination. This is not an OS sandbox or a process-group supervisor:
an independently launched descendant is outside this direct-child guarantee.

HTTP cleanup makes a best-effort session DELETE before closing local streams.
The DELETE has a bounded wait. A server may reject or ignore it, in which case
server-side expiration is still the server's responsibility; closing the browser
connection is not proof that remote state has been deleted.

## Saving safely across tabs and processes

Configuration lives in `<agent-dir>/mcp-servers.json` (normally
`~/.pi/agent/mcp-servers.json`). The version-1 document contains `servers` and
`version`; the reader refuses malformed, unknown-field or future formats instead
of treating them as an empty list and overwriting them. Back up and repair an
invalid file explicitly; deleting it is not an automatic recovery step.

Each returned server has an opaque `revision`. Edits, toggles and deletes must
send the revision that was displayed, not one silently fetched immediately before
writing. The UI does this automatically. API clients send `server.revision` for
`save`, and top-level `revision` for `toggle`/`delete`. New records omit revision.
The on-disk nonce is not the API read revision; always read through `GET /api/mcp`.

- **428** means an existing record's revision is missing. **409** means a stale
  revision, removed record, concurrent writer or creation limit. Neither response
  saves a partial change. A deleted editor cannot silently recreate the record.
- The editor keeps the draft and displays the error inside the form. **Discard
  draft and reload** is explicit: copy any changes you want to keep first. Failed
  reloads and deleted records retain the draft for reference. Inputs are disabled
  during save, so edits cannot be discarded by an older request finishing.
- A committed save remains successful if connection cleanup or Extensions reload
  subsequently fails. The response includes `cleanupWarning` / `reloadWarning`;
  the UI shows the warning. Check the connection and reload Extensions after the
  active run instead of blindly submitting the stale revision again.
- Read-modify-write uses the shared cross-process SQLite mutation lock and an
  atomic replacement with private file permissions. Readers detect manual edits
  to normalized fields even when timestamps and the stored nonce are retained.
  Revisions for unrelated records do not change when another server is edited.

New records are capped at **50**. Existing valid documents with more than 50 are
read in full and can be edited/deleted; entries are never silently truncated.
The configuration document is capped at **4 MiB**. Inputs reject invalid types,
unknown fields, relative working directories, overlong values, more than **64
arguments** or **32 headers**, duplicate header names (case-insensitive), and
header line breaks. Sensitive headers must contain an environment reference,
optionally preceded by an authentication scheme, not a literal secret with a
placeholder appended. Credentials embedded in an HTTP URL are rejected.

The editor uses one argument per line without trimming whitespace. When arguments
are untouched, exact existing strings (including empty strings or embedded
newlines) are preserved; use the JSON file for arguments with embedded newlines.
Stop writers before manual file maintenance and back up the file first.

The lock coordinates this application's cooperating processes on the same local
filesystem. It is not distributed locking, an OS sandbox or protection against a
malicious process replacing parent directories. Do not share the file with an
older running version that ignores the lock/revisions. Unsupported filesystems
or lock failures are surfaced rather than silently falling back to unsafe writes.

## Tool discovery and changes

All `tools/list` cursor pages are collected before publishing the catalog. Limits
are **50 pages**, **2000 tools**, and **2 MiB of serialized tool metadata** per
discovery. Repeated cursors, duplicate names and exceeded limits fail discovery;
the adapter does not present a partial catalog as complete. A server without the
tools capability can connect with zero tools.

Agent-facing tool IDs are deterministic, namespaced aliases of at most 64 ASCII
characters. A hash of the original server ID and tool name distinguishes names
that would otherwise collide after punctuation replacement or truncation. Display
labels retain the original names, and calls send the exact original tool name to
its server. Reload Extensions after upgrading from the older naming format;
existing transcript entries keep their historical names.

`notifications/tools/list_changed` triggers a coalesced full refresh. The existing
catalog remains visible until a complete replacement is ready. **Reload
Extensions after the active run** to update the agent's registered tools; their
schema is not silently changed mid-run. A stale, removed or disabled registration
is rejected before invocation. A closed connection may reconnect for a later call
only while its saved configuration and tool definition still match.

Structured output is validated against the tool's advertised `outputSchema` on
every page, not just the final page. Required-task execution is not implemented;
the adapter rejects these tools rather than invoking them as ordinary synchronous
calls. Cancelling one tool request sends protocol cancellation without closing a
shared connection needed by other sessions.

## Credentials, scope and current limits

- Only configure commands and endpoints you trust. A stdio process has the Web
  server account's permissions. Selecting a project scopes which sessions see
  the tools; it does **not** sandbox the MCP server's filesystem or network access.
- Sensitive HTTP headers must reference server environment variables, for example
  `{"Authorization":"Bearer ${MCP_TOKEN}"}`. Do not paste tokens into commands,
  URLs, arguments or documentation. Restart the Web server after changing its
  environment so connections use the new values.
- Current transport support is stdio and Streamable HTTP, not legacy HTTP+SSE.
  OAuth/PKCE credential management, resource/prompt browsing and task-based MCP
  execution are not yet integrated. Embedded resource links in tool results do
  not imply a complete resources client.

These contracts are checked with mock lifecycle tests, actual SDK/stdio child
processes, loopback HTTP/SSE servers, versioned persistence/API tests, and the
timeout/conflict forms' regression tests.
They do not certify a third-party server, its permissions, availability or billing.
