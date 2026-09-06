import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ListToolsResultSchema, ToolListChangedNotificationSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation";
import type { McpServerConfig, McpServerStatus } from "./mcp";
import { redactedErrorMessage } from "./redaction";

const MAX_TOOL_PAGES = 50;
const MAX_TOOLS = 2_000;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const HEALTH_INTERVAL_MS = 30_000;

export function mcpSignature(server: McpServerConfig): string {
  return JSON.stringify({ ...server, createdAt: undefined, updatedAt: undefined });
}

function interpolate(value: string): string {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/gi, (_, key: string) => {
    if (process.env[key] === undefined) throw new Error(`Missing environment variable: ${key}`);
    return process.env[key]!;
  });
}

type Transport = StdioClientTransport | StreamableHTTPClientTransport;
type Pair = { client: Client; transport: Transport };
type Entry = Pair & {
  server: McpServerConfig;
  signature: string;
  tools: Tool[];
  outputValidators: Map<string, JsonSchemaValidator<unknown>>;
  lifetime: AbortController;
  ready: Promise<Entry>;
  closed: boolean;
  closing?: Promise<void>;
  discovery?: Promise<void>;
  dirty: boolean;
  health?: Promise<void>;
  checkedAt: number;
  catalogChanged: boolean;
  publish: boolean;
};

class OwnedStdioTransport extends StdioClientTransport {
  private closing?: Promise<void>;
  private exited?: Promise<void>;

  override start(): Promise<void> {
    const onclose = this.onclose;
    this.exited = new Promise((resolve) => {
      this.onclose = () => { resolve(); onclose?.(); };
    });
    return super.start();
  }

  override close(): Promise<void> {
    // Client.connect starts close without awaiting it on initialize failure.
    // SDK stdio.close clears its process reference before awaiting exit, so a
    // second call otherwise resolves while that first cleanup is still running.
    if (this.closing) return this.closing;
    const hasChild = this.pid !== null;
    return this.closing = (async () => {
      await super.close();
      // SDK's final SIGKILL is not awaited. Observe actual child exit too,
      // bounded in case a descendant holds inherited stdio handles open.
      if (hasChild && this.exited) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([this.exited, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("MCP child exit could not be confirmed")), 2000);
            timer.unref();
          })]);
        } finally { if (timer) clearTimeout(timer); }
      }
    })();
  }
}

class OwnedHttpTransport extends StreamableHTTPClientTransport {
  private closing?: Promise<void>;
  override close(): Promise<void> {
    return this.closing ??= (async () => {
      // Dispose this client's server-side session before aborting its fetches.
      // DELETE is best effort (servers may refuse it); local streams must close.
      try { await this.terminateSession(); } catch { /* server-side expiry may be required */ }
      finally { await super.close(); }
    })();
  }
}

function createPair(server: McpServerConfig): Pair {
  const transport = server.transport === "http"
    ? new OwnedHttpTransport(new URL(server.url!), {
      requestInit: { headers: Object.fromEntries(Object.entries(server.headers ?? {}).map(([key, value]) => [key, interpolate(value)])) },
      fetch: (url, init) => fetch(url, init?.method === "DELETE" ? { ...init,
        signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(Math.min(server.timeoutMs, 2000))]) } : init),
    })
    : new OwnedStdioTransport({ command: server.command!, args: (server.args ?? []).map(interpolate),
      ...(server.cwd ? { cwd: server.cwd } : {}), stderr: "pipe" });
  // Drain before spawn. Do not buffer or publish stderr, which may contain
  // credentials; unconsumed PassThrough backpressure can freeze the child.
  if (transport instanceof StdioClientTransport) transport.stderr?.on("data", () => { /* discard without retention */ });
  return { client: new Client({ name: "tgd-pi-web", version: "1" }, { capabilities: {} }), transport };
}

/** Owns every connection from before initialize until after transport cleanup. */
export class McpConnectionManager {
  private entries = new Map<string, Entry>();
  private statuses = new Map<string, McpServerStatus>();

  constructor(private readonly makePair: (server: McpServerConfig) => Pair = createPair) {}

  status(server: McpServerConfig): McpServerStatus {
    if (!server.enabled) return { id: server.id, state: "disabled", toolCount: 0, tools: [] };
    return this.statuses.get(server.id) ?? { id: server.id, state: "idle", toolCount: 0, tools: [] };
  }

  private owns(entry: Entry): boolean { return entry.publish && this.entries.get(entry.server.id) === entry; }

  private connected(entry: Entry): McpServerStatus {
    return { id: entry.server.id, state: "connected", toolCount: entry.tools.length,
      tools: entry.tools.map(({ name, title, description }) => ({ name, title, description })),
      checkedAt: new Date(entry.checkedAt).toISOString(), catalogChanged: entry.catalogChanged };
  }

  private publish(entry: Entry): void {
    if (this.owns(entry) && !entry.closed) this.statuses.set(entry.server.id, this.connected(entry));
  }

  private close(entry: Entry): Promise<void> {
    if (entry.closing) return entry.closing;
    entry.closed = true;
    entry.lifetime.abort(new Error("MCP connection was closed or replaced"));
    // SDK connect() may already have initiated close after a failed handshake.
    // The transport close is idempotent and must also run if client.close fails.
    entry.closing = (async () => {
      try { await entry.client.close(); } catch { /* still close the owned transport */ }
      await entry.transport.close();
    })();
    return entry.closing;
  }

  private async fail(entry: Entry, error: unknown, state: "error" | "disconnected" = "error"): Promise<void> {
    let failedStatus: McpServerStatus | undefined;
    if (this.owns(entry)) {
      this.entries.delete(entry.server.id);
      failedStatus = { id: entry.server.id, state, tools: [], toolCount: 0,
        error: redactedErrorMessage(error), checkedAt: new Date().toISOString() };
      this.statuses.set(entry.server.id, failedStatus);
    }
    try { await this.close(entry); }
    catch (cleanupError) {
      // Keep background notification/close handlers free of unhandled rejects,
      // but never overwrite a replacement connection's status.
      if (failedStatus && this.statuses.get(entry.server.id) === failedStatus) {
        this.statuses.set(entry.server.id, { id: entry.server.id, state: "error", tools: [], toolCount: 0,
          error: `MCP cleanup failed: ${redactedErrorMessage(cleanupError)}`, checkedAt: new Date().toISOString() });
      }
    }
  }

  async invalidate(id: string): Promise<void> {
    const entry = this.entries.get(id);
    this.entries.delete(id);
    this.statuses.delete(id);
    if (entry) await this.close(entry);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.invalidate(id)));
  }

  private assertOpen(entry: Entry): void {
    if (entry.closed) throw new Error("MCP connection was closed or replaced");
  }

  private options(entry: Entry, deadline: number) {
    this.assertOpen(entry);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("MCP discovery timed out");
    return { timeout: remaining, maxTotalTimeout: remaining, resetTimeoutOnProgress: false, signal: entry.lifetime.signal };
  }

  private async listAll(entry: Entry, deadline: number): Promise<Tool[]> {
    if (!entry.client.getServerCapabilities()?.tools) return [];
    const tools: Tool[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let bytes = 0;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      // SDK listTools replaces its validation/task cache with EACH page. Use
      // the public protocol API and own one complete, immutable catalog instead
      // of reaching into private SDK caches or losing earlier-page validation.
      const listed = await entry.client.request({ method: "tools/list",
        ...(cursor === undefined ? {} : { params: { cursor } }) }, ListToolsResultSchema, this.options(entry, deadline));
      this.assertOpen(entry);
      bytes += Buffer.byteLength(JSON.stringify(listed.tools));
      if (bytes > MAX_CATALOG_BYTES || tools.length + listed.tools.length > MAX_TOOLS) throw new Error("MCP tool catalog exceeds the supported limit");
      for (const tool of listed.tools) {
        if (names.has(tool.name)) throw new Error(`MCP returned a duplicate tool name: ${tool.name}`);
        names.add(tool.name);
        tools.push(tool);
      }
      if (listed.nextCursor === undefined) return tools;
      if (cursors.has(listed.nextCursor)) throw new Error("MCP tool pagination repeated a cursor");
      cursors.add(listed.nextCursor);
      cursor = listed.nextCursor;
    }
    throw new Error("MCP tool pagination exceeds the supported page limit");
  }

  private discover(entry: Entry, deadline = Date.now() + entry.server.timeoutMs): Promise<void> {
    if (entry.discovery) return entry.discovery;
    entry.discovery = (async () => {
      let next: Tool[];
      do {
        entry.dirty = false;
        next = await this.listAll(entry, deadline);
        this.assertOpen(entry);
      } while (entry.dirty); // A change during pagination requires a fresh full snapshot.
      const validators = new Map<string, JsonSchemaValidator<unknown>>();
      for (const tool of next) {
        // A separate provider per schema avoids stale/shared $id caches across
        // servers, tools and changed catalogs. No remote schema loading occurs.
        if (tool.outputSchema) validators.set(tool.name, new AjvJsonSchemaValidator().getValidator(tool.outputSchema));
      }
      if (entry.checkedAt && JSON.stringify(next) !== JSON.stringify(entry.tools)) entry.catalogChanged = true;
      entry.tools = next;
      entry.outputValidators = validators;
      entry.checkedAt = Date.now();
      this.publish(entry);
    })().finally(() => { entry.discovery = undefined; });
    return entry.discovery;
  }

  private create(server: McpServerConfig, publish: boolean, prior?: Promise<void>): Entry {
    const entry: Entry = { ...this.makePair(server), server, signature: mcpSignature(server), tools: [], outputValidators: new Map(),
      lifetime: new AbortController(), ready: undefined!, closed: false, dirty: false,
      checkedAt: 0, catalogChanged: false, publish };
    if (publish) {
      this.entries.set(server.id, entry);
      this.statuses.set(server.id, { id: server.id, state: "connecting", toolCount: 0, tools: [] });
    }
    entry.client.onclose = () => {
      if (!entry.closed) void this.fail(entry, new Error("MCP server disconnected"), "disconnected");
    };
    // Protocol errors may be recoverable. A health probe decides liveness;
    // a clean tool result with isError does not imply transport failure.
    entry.client.onerror = (error) => {
      if (this.owns(entry) && !entry.closed) {
        this.statuses.set(server.id, { ...this.status(entry.server), state: "error", error: redactedErrorMessage(error) });
        entry.checkedAt = 0;
      }
    };
    entry.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      if (entry.closed) return;
      entry.dirty = true;
      // Wait for initialize/initial discovery, coalesce bursts, never register
      // new agent tools in the middle of a running model turn.
      void entry.ready.then(() => this.discover(entry)).catch((error) => this.fail(entry, error));
    });
    entry.ready = (async () => {
      await prior;
      const deadline = Date.now() + server.timeoutMs;
      await entry.client.connect(entry.transport, this.options(entry, deadline));
      this.assertOpen(entry);
      await this.discover(entry, deadline);
      return entry;
    })().catch(async (error) => { await this.fail(entry, error); throw new Error(redactedErrorMessage(error), { cause: error }); });
    return entry;
  }

  connect(server: McpServerConfig): Promise<Entry> {
    const current = this.entries.get(server.id);
    if (current && !current.closed && current.signature === mcpSignature(server)) return current.ready;
    // Claim the slot synchronously, before awaiting old teardown, so concurrent
    // callers cannot start duplicate processes. Late old callbacks cannot own it.
    const prior = this.invalidate(server.id);
    try { return this.create(server, true, prior).ready; }
    catch (error) {
      this.statuses.set(server.id, { id: server.id, state: "error", toolCount: 0, tools: [], error: redactedErrorMessage(error) });
      return prior.catch(() => {}).then(() => { throw new Error(redactedErrorMessage(error)); });
    }
  }

  async refresh(server: McpServerConfig): Promise<McpServerStatus> {
    if (!server.enabled) return this.status(server);
    const entry = await this.connect(server);
    if (Date.now() - entry.checkedAt >= HEALTH_INTERVAL_MS) {
      entry.health ??= (async () => {
        try {
          await entry.client.ping(this.options(entry, Date.now() + server.timeoutMs));
          this.assertOpen(entry);
          entry.checkedAt = Date.now();
          this.publish(entry);
        } catch (error) { await this.fail(entry, error); throw error; }
      })().finally(() => { entry.health = undefined; });
      await entry.health;
    }
    return this.status(server);
  }

  async test(server: McpServerConfig): Promise<McpServerStatus> {
    // One-time diagnostics must not evict a shared connection or keep a
    // disabled/unsaved local command running after the user approved one test.
    const entry = this.create(server, false);
    try { await entry.ready; return this.connected(entry); }
    finally { await this.close(entry); }
  }

  async callTool(server: McpServerConfig, expected: Tool, args: Record<string, unknown>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const entry = await this.connect(server);
    // Never execute against an intermediate/stale pagination snapshot.
    await entry.discovery;
    this.assertOpen(entry);
    signal?.throwIfAborted();
    const current = entry.tools.find((tool) => tool.name === expected.name);
    if (!current || JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new Error("MCP tool definition changed or was removed. Reload Extensions before calling this tool.");
    }
    if (current.execution?.taskSupport === "required") {
      throw new Error("This MCP tool requires task-based execution, which is not supported by the Web adapter yet.");
    }
    const validate = entry.outputValidators.get(current.name);
    const result = await entry.client.request({ method: "tools/call", params: { name: current.name, arguments: args } }, CallToolResultSchema, {
      ...this.options(entry, Date.now() + server.timeoutMs),
      signal: signal ? AbortSignal.any([signal, entry.lifetime.signal]) : entry.lifetime.signal,
    });
    if (validate) {
      if (result.structuredContent === undefined && !result.isError) throw new Error(`MCP tool ${current.name} did not return required structured content`);
      if (result.structuredContent !== undefined && !validate(result.structuredContent).valid) {
        // Do not reflect arbitrary server schemas/result data into diagnostics.
        throw new Error(`MCP tool ${current.name} returned structured content that does not match its output schema`);
      }
    }
    return result;
  }
}
