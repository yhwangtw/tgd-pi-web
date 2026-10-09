import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai-durable";
import { createRegistry, defineExtension, defineTool, Harness, type HarnessOptions } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { McpConnectionManager } from "../mcp-client";
import { validateMcpServer } from "../mcp";

const context = BACKGROUND_CONTEXT;
const directories: string[] = [];
const managers: McpConnectionManager[] = [];
const harnesses = new Set<Harness>();
type FixtureEvent = { type: string; method?: string; params?: { name?: string } };

async function close(harness: Harness) {
  if (harnesses.delete(harness)) await harness.close(context);
}

afterEach(async () => {
  for (const harness of [...harnesses]) await close(harness);
  for (const manager of managers.splice(0)) await manager.closeAll();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// A probe-only adapter: this does not enable MCP in the product Durable backend.
// The protocol client and subprocess are real; only the model is deterministic.
async function fixture(mode = "normal") {
  const directory = mkdtempSync(join(tmpdir(), "pi-durable-mcp-audit-"));
  directories.push(directory);
  const eventFile = join(directory, "mcp-events.jsonl");
  const manager = new McpConnectionManager();
  managers.push(manager);
  const server = validateMcpServer({ id: "durable-mcp-audit", name: "Durable MCP audit", enabled: true,
    command: process.execPath, args: [resolve("lib/__tests__/fixtures/mcp-server.mjs"), mode, eventFile], timeoutMs: 10_000 });
  const entry = await manager.connect(server);
  const remoteTool = entry.tools.find(tool => tool.name === "first")!;
  const registry = createRegistry();
  registry.install(defineExtension({ name: "mcp-audit", tools: [defineTool({
    name: "mcp_fixture", description: "Run the local MCP fixture tool",
    parameters: Type.Object({ hang: Type.Optional(Type.Boolean()), valid: Type.Optional(Type.Boolean()) }),
    // No replay annotation: unknown remote tools must retain Durable's unsafe default.
    execute: async (args, _api, callContext) => {
      const result = await manager.callTool(server, remoteTool, args, callContext.abortSignal);
      return { content: result.content.flatMap(block => block.type === "text" ? [{ type: "text" as const, text: block.text }] : []),
        ...(result.isError ? { isError: true } : {}) };
    },
  })] }));
  const faux = fauxProvider({ provider: "durable-mcp-audit", models: [{ id: "offline" }], tokensPerSecond: 0 });
  const models = createModels();
  models.setProvider(faux.provider);
  const open = async () => {
    const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "agent.sqlite")), {
      models: models as unknown as HarnessOptions["models"], registry,
    }, context);
    harnesses.add(harness);
    const root = await harness.root(context, { agent: { model: { provider: "durable-mcp-audit", modelId: "offline" }, cwd: directory } });
    return { harness, root };
  };
  const events = (): FixtureEvent[] => readFileSync(eventFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const calls = () => events().filter(event => event.method === "tools/call");
  return { manager, server, remoteTool, faux, open, events, calls };
}

describe("official Durable with the real MCP stdio client", () => {
  it("returns a real MCP result to the model and does not repeat a committed call after reopen", async () => {
    const f = await fixture();
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("mcp_fixture", {}), { stopReason: "toolUse" }),
      transcript => {
        expect(transcript.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "toolResult", toolName: "mcp_fixture",
          content: [{ type: "text", text: "first" }] })]));
        return fauxAssistantMessage("Real MCP result received");
      },
    ]);
    const first = await f.open();
    const submitted = await first.root.submit({ type: "input", content: "Use MCP once", requestId: "mcp-once" }, context);
    expect((await submitted.wait(context)).status).toBe("done");
    expect(JSON.stringify((await first.root.entries({}, 100, undefined, context)).items)).toContain("Real MCP result received");
    expect(f.calls()).toHaveLength(1);
    await close(first.harness);
    const second = await f.open();
    const duplicate = await second.root.submit({ type: "input", content: "Use MCP once", requestId: "mcp-once" }, context);
    expect(duplicate.id).toBe(submitted.id);
    expect((await duplicate.wait(context)).status).toBe("done");
    expect(f.calls()).toHaveLength(1);
    expect(f.faux.state.callCount).toBe(2);
  });

  it("propagates durable abort to MCP and does not resurrect the cancelled tool on reopen", async () => {
    const f = await fixture();
    f.faux.setResponses([fauxAssistantMessage(fauxToolCall("mcp_fixture", { hang: true }), { stopReason: "toolUse" })]);
    const first = await f.open();
    const submitted = await first.root.submit({ type: "input", content: "Wait for MCP", requestId: "mcp-cancel" }, context);
    const settled = submitted.wait(context);
    await vi.waitFor(() => expect(f.calls()).toHaveLength(1));
    await first.root.abort(context);
    expect((await settled).status).toBe("unanswered");
    await vi.waitFor(() => expect(f.events().some(event => event.method === "notifications/cancelled")).toBe(true));
    expect(f.manager.status(f.server).state).toBe("connected");
    await close(first.harness);
    const second = await f.open();
    const duplicate = await second.root.submit({ type: "input", content: "Wait for MCP", requestId: "mcp-cancel" }, context);
    expect((await duplicate.wait(context)).status).toBe("unanswered");
    expect(f.calls()).toHaveLength(1);
    expect(f.faux.state.callCount).toBe(1);
    // The cancelled call does not destroy a transport shared with other users.
    expect((await f.manager.callTool(f.server, f.remoteTool, {})).content).toEqual([{ type: "text", text: "first" }]);
  });

  it("does not replay an unsafe remote invocation interrupted by harness shutdown", async () => {
    const f = await fixture();
    f.faux.setResponses([fauxAssistantMessage(fauxToolCall("mcp_fixture", { hang: true }), { stopReason: "toolUse" })]);
    const first = await f.open();
    await first.root.submit({ type: "input", content: "Inspect interruption", requestId: "mcp-interrupt" }, context);
    await vi.waitFor(() => expect(f.calls()).toHaveLength(1));
    await close(first.harness);
    await vi.waitFor(() => expect(f.events().some(event => event.method === "notifications/cancelled")).toBe(true));
    f.faux.setResponses([transcript => {
      const interrupted = transcript.messages.find(message => message.role === "toolResult" && message.toolName === "mcp_fixture");
      expect(interrupted).toMatchObject({ isError: true });
      expect(JSON.stringify(interrupted)).toMatch(/interrupt/i);
      return fauxAssistantMessage("Remote outcome is uncertain; no automatic retry");
    }]);
    const second = await f.open();
    const resumed = await second.root.submit({ type: "input", content: "Inspect interruption", requestId: "mcp-interrupt" }, context);
    expect((await resumed.wait(context)).status).toBe("done");
    expect(JSON.stringify((await second.root.entries({}, 100, undefined, context)).items)).toContain("Remote outcome is uncertain; no automatic retry");
    expect(f.calls()).toHaveLength(1);
  });

  it("delivers MCP output-schema failures as tool errors instead of accepting invalid output", async () => {
    const f = await fixture("schemas");
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("mcp_fixture", {}), { stopReason: "toolUse" }),
      transcript => {
        const failure = transcript.messages.find(message => message.role === "toolResult" && message.toolName === "mcp_fixture");
        expect(failure).toMatchObject({ isError: true });
        expect(JSON.stringify(failure)).toContain("output schema");
        return fauxAssistantMessage("Rejected invalid remote result");
      },
    ]);
    const current = await f.open();
    const submitted = await current.root.submit({ type: "input", content: "Validate remote output", requestId: "mcp-schema" }, context);
    expect((await submitted.wait(context)).status).toBe("done");
    expect(JSON.stringify((await current.root.entries({}, 100, undefined, context)).items)).toContain("Rejected invalid remote result");
    expect(f.calls()).toHaveLength(1);
  });
});
