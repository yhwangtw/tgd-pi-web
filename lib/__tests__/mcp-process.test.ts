import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { getAgentDir, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { McpConnectionManager } from "../mcp-client";
import { createMcpExtension, saveMcpServer, validateMcpServer } from "../mcp";

let root: string;
let manager: McpConnectionManager;
const fixturePath = resolve("lib/__tests__/fixtures/mcp-server.mjs");
type Event = { pid: number; type: string; method?: string; params?: { name?: string } };
const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function events(): Promise<Event[]> {
  try { return (await readFile(join(root, "events.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
const server = (mode = "normal", timeoutMs = 2000) => validateMcpServer({ id: "fixture", name: "Fixture", enabled: true,
  command: process.execPath, args: [fixturePath, mode, join(root, "events.jsonl")], timeoutMs });
async function registered(mode = "normal") {
  const configured = await saveMcpServer(server(mode));
  const tools: ToolDefinition[] = [];
  const extension = createMcpExtension(root);
  const factory = typeof extension === "function" ? extension : extension.factory;
  await factory({ registerTool: (value: ToolDefinition) => { tools.push(value); } } as never);
  expect(tools.length).toBeGreaterThan(0);
  const call = (suffix: string, args = {}, signal?: AbortSignal) => {
    const tool = tools.find((tool) => tool.label === `Fixture · ${suffix}`);
    if (!tool) throw new Error(`Missing registered fixture tool: ${suffix}`);
    return tool.execute("fixture-call", args, signal, undefined, {} as never);
  };
  return { configured, tools, call };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-mcp-process-"));
  manager = new McpConnectionManager();
  globalThis.__piMcpManager = manager;
  await rm(join(getAgentDir(), "mcp-servers.json"), { force: true });
});
afterEach(async () => {
  await manager.closeAll();
  globalThis.__piMcpManager = undefined;
  const pids = [...new Set((await events()).map((event) => event.pid))];
  try { await vi.waitFor(() => { for (const pid of pids) expect(isAlive(pid)).toBe(false); }, { timeout: 5000 }); }
  finally {
    // Only ever clean up PIDs written by this test's spawned fixture.
    for (const pid of pids) if (isAlive(pid)) process.kill(pid, "SIGTERM");
    await rm(root, { recursive: true, force: true });
  }
});

describe("MCP with real SDK and stdio processes", () => {
  it("registers stable bounded tool names without punctuation, truncation or server-prefix collisions", async () => {
    const configurations = [];
    for (const separator of ["-", "_"]) {
      configurations.push(await saveMcpServer({ ...server("names"), id: `server${separator}${"long".repeat(25)}`, name: `Server ${separator}` }));
    }
    const load = async () => {
      const tools: ToolDefinition[] = [];
      const extension = createMcpExtension(root);
      const factory = typeof extension === "function" ? extension : extension.factory;
      await factory({ registerTool: (value: ToolDefinition) => { tools.push(value); } } as never);
      return tools;
    };
    const tools = await load();
    expect(tools).toHaveLength(12);
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(12);
    for (const tool of tools) expect(tool.name).toMatch(/^mcp_[a-zA-Z0-9_-]{1,60}$/);
    for (const config of configurations) {
      for (const originalName of ["search.files", "search/files", "search_files", "工具查詢", `${"x".repeat(80)}a`, `${"x".repeat(80)}b`]) {
        const tool = tools.find((entry) => entry.label === `${config.name} · ${originalName}`)!;
        const result = await tool.execute("name-regression", {}, undefined, undefined, {} as never);
        expect(result.content).toEqual([{ type: "text", text: originalName }]);
        expect(result.details).toMatchObject({ serverId: config.id, toolName: originalName });
      }
    }
    const reloaded = await load();
    expect(new Map(reloaded.map((tool) => [tool.label, tool.name]))).toEqual(new Map(tools.map((tool) => [tool.label, tool.name])));
    expect((await events()).filter((event) => event.type === "start")).toHaveLength(2);
  });
  it("shares initialization, discovers every page and closes a successful standalone probe", async () => {
    const config = server();
    const results = await Promise.all([manager.refresh(config), manager.refresh(config)]);
    expect(results[0].tools.map((tool) => tool.name)).toEqual(["first", "second"]);
    expect((await events()).filter((event) => event.type === "start")).toHaveLength(1);
    await manager.test({ ...config, enabled: false });
    const starts = (await events()).filter((event) => event.type === "start");
    expect(starts).toHaveLength(2);
    expect(isAlive(starts[0].pid)).toBe(true);
    expect(isAlive(starts[1].pid)).toBe(false);
    expect(manager.status(config).state).toBe("connected");
  });
  it.each(["fail-list", "hang-initialize", "hang-list"])("reaps the child after %s rather than leaving a process behind", async (mode) => {
    await expect(manager.test(server(mode, 1000))).rejects.toThrow();
    const starts = (await events()).filter((event) => event.type === "start");
    expect(starts).toHaveLength(1);
    expect(isAlive(starts[0].pid)).toBe(false);
  });
  it("drains stderr beyond pipe capacity without blocking initialization", async () => {
    expect((await manager.test(server("stderr"))).toolCount).toBe(2);
  });
  it("waits for an uncooperative child to exit after forced cleanup", async () => {
    const config = server("stubborn");
    await manager.refresh(config);
    const pid = (await events()).find((event) => event.type === "start")!.pid;
    await manager.invalidate(config.id);
    expect(isAlive(pid)).toBe(false);
  }, 10000);
  it("accepts a server without tools without sending tools/list", async () => {
    expect((await manager.test(server("no-tools"))).toolCount).toBe(0);
    expect((await events()).some((event) => event.method === "tools/list")).toBe(false);
  });
  it("rejects invalid structured output from both first and last discovery pages", async () => {
    const { call } = await registered("schemas");
    await expect(call("first")).rejects.toThrow(/output schema/i);
    await expect(call("last")).rejects.toThrow(/output schema/i);
    await expect(call("first", { missing: true })).rejects.toThrow(/structured content/i);
    expect((await call("first", { valid: true })).content).toHaveLength(1);
  });
  it("does not invoke an unsupported required-task tool from an earlier page", async () => {
    const { call } = await registered("schemas");
    await expect(call("task")).rejects.toThrow(/task/i);
    expect((await events()).filter((event) => event.method === "tools/call")).toHaveLength(0);
  });
  it("refreshes list_changed and refuses a removed tool instead of executing its stale registration", async () => {
    const { configured, call } = await registered();
    await call("first", { change: true });
    await vi.waitFor(() => expect(manager.status(configured).tools.map((tool) => tool.name)).toEqual(["updated"]));
    expect(manager.status(configured).catalogChanged).toBe(true);
    await expect(call("first")).rejects.toThrow(/definition changed or was removed/);
    expect((await events()).filter((event) => event.method === "tools/call")).toHaveLength(1);
  });
  it("reconnects the same config for a registered tool but refuses a disabled config", async () => {
    const { configured, call } = await registered();
    await manager.invalidate(configured.id);
    expect((await call("first")).content).toEqual([{ type: "text", text: "first" }]);
    expect((await events()).filter((event) => event.type === "start")).toHaveLength(2);
    await saveMcpServer({ ...configured, enabled: false });
    await expect(call("first")).rejects.toThrow(/disabled/);
    expect((await events()).filter((event) => event.method === "tools/call")).toHaveLength(1);
  });
  it("cancels a tool request without closing the shared transport", async () => {
    const { configured, call } = await registered();
    const controller = new AbortController();
    const pending = call("first", { hang: true }, controller.signal);
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(async () => expect((await events()).some((event) => event.method === "tools/call")).toBe(true));
    controller.abort(new Error("fixture cancellation"));
    await rejected;
    await vi.waitFor(async () => expect((await events()).some((event) => event.method === "notifications/cancelled")).toBe(true));
    expect(manager.status(configured).state).toBe("connected");
    expect((await call("second")).content).toHaveLength(1);
  });
});
