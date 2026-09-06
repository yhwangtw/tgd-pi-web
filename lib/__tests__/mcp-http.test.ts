import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import { McpConnectionManager } from "../mcp-client";
import { validateMcpServer } from "../mcp";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(mode = "normal") {
  let nextId = 0;
  let changed = false;
  const sessions = new Set<string>();
  const streams = new Map<string, ServerResponse>();
  const pending = new Set<ServerResponse>();
  const requests: Array<{ method: string; session?: string }> = [];
  const tool = (name: string) => ({ name, inputSchema: { type: "object", properties: {} } });
  const http = createServer(async (req, res) => {
    pending.add(res);
    res.on("close", () => pending.delete(res));
    const session = req.headers["mcp-session-id"] as string | undefined;
    if (req.method === "DELETE") {
      requests.push({ method: "DELETE", session });
      if (mode === "hang-delete") return;
      if (mode === "refuse-delete") { res.writeHead(405).end(); return; }
      if (session) { sessions.delete(session); streams.get(session)?.end(); }
      res.writeHead(200).end(); return;
    }
    if (req.method === "GET") {
      if (!session || !sessions.has(session)) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": fixture connected\n\n");
      streams.set(session, res);
      res.on("close", () => { if (streams.get(session) === res) streams.delete(session); });
      return;
    }
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const message = JSON.parse(body);
    requests.push({ method: message.method, session });
    const reply = (result: unknown, headers = {}) => res.writeHead(200, { "Content-Type": "application/json", ...headers })
      .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (message.method === "initialize") {
      if (mode === "hang-initialize") return;
      const sid = String(++nextId);
      sessions.add(sid);
      reply({ protocolVersion: message.params.protocolVersion, serverInfo: { name: "http-fixture", version: "1" },
        capabilities: { tools: { listChanged: true } } }, { "Mcp-Session-Id": sid });
    } else if (message.method === "tools/list") {
      if (mode === "hang-list") return;
      reply(changed ? { tools: [tool("new")] } : message.params?.cursor === "second"
        ? { tools: [tool("second")] } : { tools: [tool("first")], nextCursor: "second" });
    } else if (message.method === "tools/call") {
      if (message.params.arguments?.change) {
        changed = true;
        streams.get(session!)?.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`);
      }
      reply({ content: [{ type: "text", text: "ok" }] });
    } else if (message.id !== undefined) reply({});
    else res.writeHead(202).end();
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
  });
  const manager = new McpConnectionManager();
  cleanup.push(() => manager.closeAll());
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP fixture port");
  const server = validateMcpServer({ name: "HTTP fixture", enabled: true, transport: "http",
    url: `http://127.0.0.1:${address.port}/mcp`, timeoutMs: 1000 });
  return { manager, server, sessions, streams, pending, requests };
}

describe("MCP with real SDK and Streamable HTTP", () => {
  it("tests a separate session and terminates only the session it owns", async () => {
    const f = await fixture();
    await Promise.all([f.manager.refresh(f.server), f.manager.refresh(f.server)]);
    expect(f.requests.filter((request) => request.method === "initialize")).toHaveLength(1);
    expect(f.manager.status(f.server).toolCount).toBe(2);
    await vi.waitFor(() => expect(f.streams.size).toBe(1));
    const sharedSession = [...f.sessions][0];
    expect((await f.manager.test({ ...f.server, enabled: false })).state).toBe("connected");
    expect([...f.sessions]).toEqual([sharedSession]);
    expect(f.requests.filter((request) => request.method === "DELETE")).toEqual([{ method: "DELETE", session: "2" }]);
    await f.manager.invalidate(f.server.id);
    expect(f.sessions.size).toBe(0);
    await vi.waitFor(() => expect(f.streams.size).toBe(0));
  });
  it.each(["hang-initialize", "hang-list"])("aborts pending HTTP requests and tears down on %s", async (mode) => {
    const f = await fixture(mode);
    await expect(f.manager.test(f.server)).rejects.toThrow(/timed out/i);
    await vi.waitFor(() => expect(f.pending.size).toBe(0));
    expect(f.sessions.size).toBe(0);
  });
  it.each(["refuse-delete", "hang-delete"])("still closes local streams when remote cleanup is %s", async (mode) => {
    const f = await fixture(mode);
    const started = Date.now();
    expect((await f.manager.test(f.server)).state).toBe("connected");
    expect(Date.now() - started).toBeLessThan(3000);
    await vi.waitFor(() => expect(f.pending.size).toBe(0));
    expect(f.requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
    // A refusing server owns expiry. Local cleanup is not proof of remote deletion.
    expect(f.sessions.size).toBe(1);
  });
  it("receives list_changed over SSE and blocks a stale registered tool", async () => {
    const f = await fixture();
    const entry = await f.manager.connect(f.server);
    const first = entry.tools[0];
    await vi.waitFor(() => expect(f.streams.size).toBe(1));
    await f.manager.callTool(f.server, first, { change: true });
    await vi.waitFor(() => expect(f.manager.status(f.server).tools.map((tool) => tool.name)).toEqual(["new"]));
    await expect(f.manager.callTool(f.server, first, {})).rejects.toThrow(/definition changed/);
    expect(f.requests.filter((request) => request.method === "tools/call")).toHaveLength(1);
  });
});
