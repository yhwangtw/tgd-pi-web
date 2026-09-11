import { rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readMcpServers } from "../mcp";

const runtime = vi.hoisted(() => ({ getSession: vi.fn(), reload: vi.fn(async () => {}) }));
vi.mock("@/lib/rpc-manager", () => ({ getRpcSession: runtime.getSession }));
import { GET, POST } from "../../app/api/mcp/route";

const invalidated = vi.fn(async () => {});
const configPath = () => join(getAgentDir(), "mcp-servers.json");
const seed = { id: "fixture", name: "Fixture", transport: "http", url: "https://example.test/mcp", enabled: false };
function post(body: unknown) {
  return POST(new Request("http://localhost/api/mcp", { method: "POST", headers: {
    "content-type": "application/json", origin: "http://localhost", "sec-fetch-site": "same-origin",
  }, body: JSON.stringify(body) }));
}
beforeEach(async () => {
  await rm(configPath(), { force: true });
  invalidated.mockReset(); runtime.getSession.mockReset(); runtime.reload.mockReset();
  globalThis.__piMcpManager = { invalidate: invalidated, status: (server: { id: string }) => ({ id: server.id, state: "disabled", toolCount: 0, tools: [] }) } as never;
});
afterEach(() => { globalThis.__piMcpManager = undefined; });

describe("MCP route with real persistence", () => {
  it("returns read revisions and enforces them for save, toggle and delete", async () => {
    const created = await post({ action: "save", server: seed });
    expect(created.status).toBe(200);
    const initial = (await created.json()).server;
    const listed = await GET(new Request("http://localhost/api/mcp"));
    expect((await listed.json()).servers[0]).toEqual(initial);
    const updated = await post({ action: "save", server: { ...initial, name: "Other tab" } });
    expect(updated.status).toBe(200);
    const current = (await updated.json()).server;
    for (const revision of [undefined, initial.revision]) {
      for (const action of ["save", "toggle", "delete"]) {
        const response = await post({ action, id: seed.id, revision, enabled: false, server: { ...initial, revision, name: "Stale" } });
        expect(response.status).toBe(revision ? 409 : 428);
        expect(await readMcpServers()).toEqual([current]);
      }
    }
    const toggled = await post({ action: "toggle", id: seed.id, revision: current.revision, enabled: false });
    expect(toggled.status).toBe(200);
    const next = (await toggled.json()).server;
    expect(next.revision).not.toBe(current.revision);
    const removed = await post({ action: "delete", id: seed.id, revision: next.revision });
    expect(removed.status).toBe(200);
    expect(await readMcpServers()).toEqual([]);
    expect((await post({ action: "save", server: next })).status).toBe(409);
  });
  it("does not report a committed save as failed when runtime reload fails", async () => {
    runtime.getSession.mockReturnValue({ isAlive: () => true, inner: {}, reloadExtensions: runtime.reload });
    runtime.reload.mockRejectedValueOnce(new Error("runtime reload unavailable"));
    const response = await post({ action: "save", server: seed, sessionId: "test-session" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.reloaded).toBe(false);
    expect(body.reloadWarning).toContain("configuration was saved");
    expect(await readMcpServers()).toEqual([body.server]);
  });
  it("returns cleanup warnings without losing the successful revision", async () => {
    invalidated.mockRejectedValueOnce(new Error("cleanup unavailable"));
    const response = await post({ action: "save", server: seed });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.cleanupWarning).toContain("configuration was saved");
    expect((await readMcpServers())[0].revision).toBe(body.server.revision);
  });
  it.each([null, [], { action: "save", server: { ...seed, enabled: "false" } }, { action: "delete", id: 7 }])("rejects malformed request %j without changing storage", async body => {
    await post({ action: "save", server: seed });
    const before = await readFile(configPath(), "utf8");
    expect((await post(body)).status).toBe(400);
    expect(await readFile(configPath(), "utf8")).toBe(before);
  });
  it("rejects cross-origin writes before any mutation", async () => {
    const response = await POST(new Request("http://localhost/api/mcp", { method: "POST", headers: {
      origin: "http://other.test", "content-type": "application/json",
    }, body: JSON.stringify({ action: "save", server: seed }) }));
    expect(response.status).toBe(403);
    expect(await readMcpServers()).toEqual([]);
  });
  it.each<Record<string, string>>([
    { origin: "http://127.0.0.1:30178", host: "127.0.0.1:30178" },
    { origin: "https://pi.example.test", host: "127.0.0.1:30178", "x-forwarded-host": "pi.example.test", "x-forwarded-proto": "https" },
  ])("accepts the actual browser origin despite Next's internal request URL: %j", async headers => {
    const response = await POST(new Request("http://localhost:30178/api/mcp", { method: "POST", headers: {
      ...headers, "content-type": "application/json", "sec-fetch-site": "same-origin",
    }, body: JSON.stringify({ action: "save", server: seed }) }));
    expect(response.status).toBe(200);
    expect(await readMcpServers()).toHaveLength(1);
  });
  it.each<Record<string, string>>([
    {}, { origin: "null" }, { origin: "not a URL" },
    { origin: "http://127.0.0.1:30179" }, { origin: "https://127.0.0.1:30178" },
    { origin: "http://127.0.0.1:30178", "sec-fetch-site": "cross-site" },
    { origin: "http://127.0.0.1:30178", "sec-fetch-site": "same-site" },
  ])("still rejects missing, opaque, cross-host or cross-protocol Origin: %j", async headers => {
    const response = await POST(new Request("http://localhost:30178/api/mcp", { method: "POST", headers: {
      host: "127.0.0.1:30178", "content-type": "application/json", ...headers,
    }, body: JSON.stringify({ action: "save", server: seed }) }));
    expect(response.status).toBe(403);
    expect(await readMcpServers()).toEqual([]);
  });
});
