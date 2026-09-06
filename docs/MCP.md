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
processes, loopback HTTP/SSE servers, and the timeout form's regression tests.
They do not certify a third-party server, its permissions, availability or billing.
