import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai-durable";
import { createRegistry, Harness, type HarnessOptions } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createDurableMcpExtension } from "../durable-mcp";
import { McpConnectionManager } from "../mcp-client";
import { readMcpServers, saveMcpServer, validateMcpServer } from "../mcp";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const context = BACKGROUND_CONTEXT;
const directories: string[] = [];
const managers: McpConnectionManager[] = [];
const opened = new Set<Harness>();
async function close(harness: Harness) { await harness.close(context); opened.delete(harness); }
afterEach(async () => {
  for (const harness of [...opened]) await close(harness);
  for (const manager of managers.splice(0)) await manager.closeAll();
  globalThis.__piMcpManager = undefined;
  rmSync(join(getAgentDir(), "mcp-servers.json"), { force: true });
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function fixture(mode = "normal", timeoutMs = 2_000) {
  const directory = mkdtempSync(join(tmpdir(), "pi-durable-mcp-")); directories.push(directory);
  const eventFile = join(directory, "events.jsonl");
  const manager = new McpConnectionManager(); managers.push(manager); globalThis.__piMcpManager = manager;
  const server = await saveMcpServer(validateMcpServer({ id: "durable-fixture", name: "Durable fixture", enabled: true,
    command: process.execPath, args: [resolve("lib/__tests__/fixtures/mcp-server.mjs"), mode, eventFile], timeoutMs }), { trustStdio: true });
  const extension = await createDurableMcpExtension(directory);
  const name = extension.tools![0].name;
  const registry = createRegistry(); registry.install(extension);
  const models = createModels();
  const faux = fauxProvider({ provider: "mcp-test", models: [{ id: "model" }], tokensPerSecond: 0 }); models.setProvider(faux.provider);
  async function open() {
    const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "state.sqlite")), {
      models: models as unknown as HarnessOptions["models"], registry, settings: { retry: { enabled: false }, compaction: { enabled: false } },
    }, context);
    opened.add(harness);
    const root = await harness.root(context, { agent: { model: { provider: "mcp-test", modelId: "model" }, cwd: directory } });
    return { harness, root };
  }
  const events = (): Array<{ method?: string; type?: string }> => readFileSync(eventFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const calls = () => events().filter(event => event.method === "tools/call");
  return { directory, manager, server, extension, name, registry, faux, open, events, calls };
}

describe("Durable production MCP extension", () => {
  it("uses canonical names and tool output and never replays a committed call on reopen", async () => {
    const f = await fixture();
    expect(f.extension.tools).toHaveLength(2);
    for (const tool of f.extension.tools!) { expect(tool.name).toMatch(/^mcp_[A-Za-z0-9_-]{1,60}$/); expect(tool.replay).toBe("unsafe"); }
    f.faux.setResponses([fauxAssistantMessage(fauxToolCall(f.name, {}), { stopReason: "toolUse" }), transcript => {
      expect(transcript.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "toolResult", toolName: f.name, content: [{ type: "text", text: "first" }] })]));
      return fauxAssistantMessage("MCP result consumed");
    }]);
    const first = await f.open();
    const input = { type: "input", content: "Call MCP", requestId: "once" } as const;
    expect((await (await first.root.submit(input, context)).wait(context)).status).toBe("done");
    expect(JSON.stringify((await first.root.context(context)).messages)).toContain("MCP result consumed");
    await close(first.harness);
    const second = await f.open();
    expect((await (await second.root.submit(input, context)).wait(context)).status).toBe("done");
    expect(f.calls()).toHaveLength(1);
  });

  it.each(["disabled", "changed"] as const)("refuses %s persisted configuration before executing a registered tool", async action => {
    const f = await fixture();
    const server = (await readMcpServers())[0];
    await saveMcpServer({ ...server, ...(action === "disabled" ? { enabled: false } : { name: "Changed fixture" }) }, { trustStdio: true });
    f.faux.setResponses([fauxAssistantMessage(fauxToolCall(f.name, {}), { stopReason: "toolUse" }), transcript => {
      const result = transcript.messages.find(message => message.role === "toolResult");
      expect(result).toMatchObject({ isError: true }); expect(JSON.stringify(result)).toContain("configuration changed or was disabled");
      return fauxAssistantMessage("Config refusal consumed");
    }]);
    const { root } = await f.open();
    expect((await (await root.submit({ type: "input", content: "Try old tool" }, context)).wait(context)).status).toBe("done");
    expect(f.calls()).toHaveLength(0);
  });

  it("rejects a tool removed by live catalog refresh", async () => {
    const f = await fixture();
    const entry = await f.manager.connect(f.server);
    await f.manager.callTool(f.server, entry.tools[0], { change: true });
    await vi.waitFor(() => expect(f.manager.status(f.server).tools.map(tool => tool.name)).toEqual(["updated"]));
    f.faux.setResponses([fauxAssistantMessage(fauxToolCall(f.name, {}), { stopReason: "toolUse" }), transcript => {
      const result = transcript.messages.find(message => message.role === "toolResult");
      expect(result).toMatchObject({ isError: true }); expect(JSON.stringify(result)).toContain("definition changed or was removed");
      return fauxAssistantMessage("Stale tool refused");
    }]);
    const { root } = await f.open();
    expect((await (await root.submit({ type: "input", content: "Use stale tool" }, context)).wait(context)).status).toBe("done");
    expect(f.calls()).toHaveLength(1); // Only the deliberate catalog-changing call.
  });

  it("preserves remote output-schema validation", async () => {
    const f = await fixture("schemas");
    f.faux.setResponses([fauxAssistantMessage(fauxToolCall(f.name, {}), { stopReason: "toolUse" }), transcript => {
      const result = transcript.messages.find(message => message.role === "toolResult");
      expect(result).toMatchObject({ isError: true }); expect(JSON.stringify(result)).toContain("output schema");
      return fauxAssistantMessage("Invalid output refused");
    }]);
    const { root } = await f.open();
    expect((await (await root.submit({ type: "input", content: "Validate MCP" }, context)).wait(context)).status).toBe("done");
    expect(f.calls()).toHaveLength(1);
  });

  it("propagates cancellation to the real stdio process without closing the shared transport", async () => {
    const f = await fixture();
    f.faux.setResponses([fauxAssistantMessage(fauxToolCall(f.name, { hang: true }), { stopReason: "toolUse" })]);
    const { harness, root } = await f.open();
    const submission = await root.submit({ type: "input", content: "Wait" }, context);
    await vi.waitFor(() => expect(f.calls()).toHaveLength(1));
    await root.abort(context);
    expect((await submission.wait(context)).status).toBe("unanswered");
    await vi.waitFor(() => expect(f.events().some(event => event.method === "notifications/cancelled")).toBe(true));
    expect(f.manager.status(f.server).state).toBe("connected");
    await close(harness);
  });

  it("retains MCP timeouts as model-visible errors", async () => {
    const f = await fixture("normal", 1_000);
    f.faux.setResponses([fauxAssistantMessage(fauxToolCall(f.name, { hang: true }), { stopReason: "toolUse" }), transcript => {
      const result = transcript.messages.find(message => message.role === "toolResult");
      expect(result).toMatchObject({ isError: true }); expect(JSON.stringify(result)).toMatch(/timed out|timeout/i);
      return fauxAssistantMessage("Timeout consumed");
    }]);
    const { root } = await f.open();
    expect((await (await root.submit({ type: "input", content: "Wait" }, context)).wait(context)).status).toBe("done");
    expect(f.calls()).toHaveLength(1);
  });
});
