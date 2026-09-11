import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpConnectionManager } from "../mcp-client";
import { validateMcpServer } from "../mcp";

const server = () => validateMcpServer({ id: "fixture", name: "Fixture", transport: "stdio", command: "fixture", enabled: true });
const tool = (name: string) => ({ name, inputSchema: { type: "object" as const, properties: {} } });
const managers: McpConnectionManager[] = [];
afterEach(async () => { for (const manager of managers.splice(0)) await manager.closeAll(); vi.restoreAllMocks(); });

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture() {
  let changed!: () => void;
  const client = {
    onclose: undefined as (() => void) | undefined,
    onerror: undefined as ((error: Error) => void) | undefined,
    connect: vi.fn(async () => {}), close: vi.fn(async () => {}),
    listTools: vi.fn(async (_params?: unknown, _options?: unknown): Promise<{ tools: ReturnType<typeof tool>[]; nextCursor?: string }> => ({ tools: [tool("read")] })),
    getServerCapabilities: vi.fn((): { tools?: { listChanged: boolean } } => ({ tools: { listChanged: true } })),
    ping: vi.fn(async () => ({})),
    request: vi.fn((request: { method: string; params?: unknown }, _schema: unknown, options?: unknown): Promise<unknown> => {
      if (request.method === "tools/list") return client.listTools(request.params, options);
      throw new Error(`Unexpected request: ${request.method}`);
    }),
    setNotificationHandler: vi.fn((_schema, handler) => { changed = handler; }),
  };
  const transport = { close: vi.fn(async () => {}) };
  return { client, transport, changed: () => changed(), pair: { client: client as unknown as Client, transport: transport as unknown as StdioClientTransport } };
}
function managerFor(...connections: ReturnType<typeof fixture>[]) {
  let n = 0;
  const make = vi.fn(() => { const f = connections[n++]; if (!f) throw new Error("Unexpected extra connection"); return f.pair; });
  const manager = new McpConnectionManager(make);
  managers.push(manager);
  return { manager, make };
}

describe("MCP connection ownership", () => {
  it("shares an in-flight initialization and drains only one full tool discovery", async () => {
    const f = fixture(); const ready = deferred<void>(); f.client.connect.mockReturnValue(ready.promise);
    const { manager, make } = managerFor(f);
    const first = manager.refresh(server()); const second = manager.refresh(server());
    expect(make).toHaveBeenCalledTimes(1);
    expect(manager.status(server()).state).toBe("connecting");
    ready.resolve();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(f.client.listTools).toHaveBeenCalledTimes(1);
  });
  it.each(["connect", "listTools"] as const)("cleans up both client and transport when %s fails", async (stage) => {
    const f = fixture(); f.client[stage].mockRejectedValue(new Error("Authorization: Bearer topsecret123"));
    const { manager } = managerFor(f);
    await expect(manager.refresh(server())).rejects.toThrow("[REDACTED]");
    expect(f.client.close).toHaveBeenCalled(); expect(f.transport.close).toHaveBeenCalled();
    expect(manager.status(server()).error).not.toContain("topsecret123");
  });
  it("one-time tests close themselves without disturbing the shared connection or disabled state", async () => {
    const shared = fixture(), probe = fixture(); const { manager } = managerFor(shared, probe);
    await manager.refresh(server());
    expect((await manager.test({ ...server(), enabled: false })).state).toBe("connected");
    expect(probe.transport.close).toHaveBeenCalled();
    expect(shared.transport.close).not.toHaveBeenCalled();
    expect(manager.status(server()).state).toBe("connected");
    expect(manager.status({ ...server(), enabled: false }).state).toBe("disabled");
  });
  it("invalidating during discovery cannot resurrect an entry or overwrite the replacement status", async () => {
    const old = fixture(), fresh = fixture(); const listing = deferred<{ tools: ReturnType<typeof tool>[] }>();
    old.client.listTools.mockReturnValue(listing.promise);
    const { manager } = managerFor(old, fresh);
    const first = manager.refresh(server()); const rejection = expect(first).rejects.toThrow("closed or replaced");
    await vi.waitFor(() => expect(old.client.listTools).toHaveBeenCalled());
    const changed = { ...server(), args: ["new"] };
    await manager.refresh(changed);
    listing.resolve({ tools: [tool("stale")] });
    await rejection;
    expect(manager.status(changed).tools.map((tool) => tool.name)).toEqual(["read"]);
    old.client.onclose?.();
    expect(manager.status(changed).state).toBe("connected");
  });
  it("reports a closed connection and reconnects on the next request", async () => {
    const old = fixture(), fresh = fixture(); const { manager } = managerFor(old, fresh);
    expect(manager.status(server()).state).toBe("idle");
    await manager.refresh(server()); old.client.onclose?.();
    expect(manager.status(server()).state).toBe("disconnected");
    await manager.refresh(server()); expect(manager.status(server()).state).toBe("connected");
    expect(fresh.client.connect).toHaveBeenCalledTimes(1);
  });
  it("single-flights health probes and never claims a failed probe is connected", async () => {
    const f = fixture(); const { manager } = managerFor(f);
    await manager.refresh(server());
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
    const health = deferred<object>(); f.client.ping.mockReturnValue(health.promise);
    const a = manager.refresh(server()), b = manager.refresh(server());
    const checked = expect(Promise.all([a, b])).rejects.toThrow("offline");
    await vi.waitFor(() => expect(f.client.ping).toHaveBeenCalledTimes(1));
    health.reject(new Error("offline")); await checked;
    expect(manager.status(server()).state).toBe("error"); expect(f.transport.close).toHaveBeenCalled();
  });
});

describe("MCP bounded tool discovery", () => {
  it("collects cursor pages, including an empty opaque cursor, before reporting connected", async () => {
    const f = fixture(); f.client.listTools.mockResolvedValueOnce({ tools: [tool("a")], nextCursor: "" }).mockResolvedValueOnce({ tools: [tool("b")] });
    const { manager } = managerFor(f);
    const result = await manager.refresh(server()); expect(result.tools.map((tool) => tool.name)).toEqual(["a", "b"]);
    expect(f.client.listTools.mock.calls[1][0]).toEqual({ cursor: "" });
  });
  it.each(["cursor", "duplicate", "size", "bytes", "pages"])("rejects %s overflow instead of reporting a partial catalog as complete", async (kind) => {
    const f = fixture();
    if (kind === "cursor") f.client.listTools.mockResolvedValue({ tools: [], nextCursor: "same" });
    if (kind === "duplicate") f.client.listTools.mockResolvedValue({ tools: [tool("same"), tool("same")] });
    if (kind === "size") f.client.listTools.mockResolvedValue({ tools: Array.from({ length: 2001 }, (_, index) => tool(String(index))) });
    if (kind === "bytes") f.client.listTools.mockResolvedValue({ tools: [tool("x".repeat(2 * 1024 * 1024))] });
    if (kind === "pages") f.client.listTools.mockImplementation(async () => ({ tools: [], nextCursor: String(f.client.listTools.mock.calls.length) }));
    const { manager } = managerFor(f); await expect(manager.refresh(server())).rejects.toThrow();
    expect(manager.status(server()).toolCount).toBe(0); expect(f.transport.close).toHaveBeenCalled();
  });
  it("does not invoke tools/list for a server without the tools capability", async () => {
    const f = fixture(); f.client.getServerCapabilities.mockReturnValue({}); const { manager } = managerFor(f);
    expect((await manager.refresh(server())).toolCount).toBe(0); expect(f.client.listTools).not.toHaveBeenCalled();
  });
  it("coalesces list_changed notifications and atomically publishes the full refreshed catalog", async () => {
    const f = fixture(); const { manager } = managerFor(f); await manager.refresh(server());
    const page = deferred<{ tools: ReturnType<typeof tool>[]; nextCursor?: string }>();
    f.client.listTools.mockReturnValueOnce(page.promise).mockResolvedValue({ tools: [tool("updated")] });
    f.changed(); f.changed(); f.changed();
    await vi.waitFor(() => expect(f.client.listTools).toHaveBeenCalledTimes(2));
    expect(manager.status(server()).tools.map((tool) => tool.name)).toEqual(["read"]);
    page.resolve({ tools: [tool("updated")] });
    await vi.waitFor(() => expect(manager.status(server()).catalogChanged).toBe(true));
    expect(f.client.listTools).toHaveBeenCalledTimes(2);
    expect(manager.status(server()).tools.map((tool) => tool.name)).toEqual(["updated"]);
  });
  it("restarts discovery when the list changes midway through pagination", async () => {
    const f = fixture(); const { manager } = managerFor(f); await manager.refresh(server());
    const page = deferred<{ tools: ReturnType<typeof tool>[]; nextCursor?: string }>();
    f.client.listTools.mockReturnValueOnce(page.promise).mockResolvedValueOnce({ tools: [tool("new")] });
    f.changed(); await vi.waitFor(() => expect(f.client.listTools).toHaveBeenCalledTimes(2));
    f.changed(); page.resolve({ tools: [tool("outdated")] });
    await vi.waitFor(() => expect(manager.status(server()).tools.map((tool) => tool.name)).toEqual(["new"]));
    expect(f.client.listTools).toHaveBeenCalledTimes(3);
  });
});
