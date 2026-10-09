import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, Type,
  type FauxResponseFactory, type TranscriptContext,
} from "@earendil-works/pi-ai-durable";
import { getCurrentTools } from "@earendil-works/pi-ai-durable/utils/transcript";
import {
  createRegistry, defineExtension, defineTool, Harness, UsageDoc,
  type Conversation, type ConversationId, type HarnessOptions, type ToolRegistration,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createDurableSubagentExtension, DurableSubagentDoc, type DurableSubagentChild, type DurableSubagentOptions } from "../durable-subagents";
import { BUILTIN_SUBAGENTS } from "../subagent-extension";

const context = BACKGROUND_CONTEXT;
const directories: string[] = [];
const harnesses = new Set<Harness>();

async function fixture(options: Partial<Omit<DurableSubagentOptions, "getHarness">> = {}, extraTools: ToolRegistration[] = []) {
  const directory = mkdtempSync(join(tmpdir(), "pi-durable-subagents-"));
  directories.push(directory);
  const faux = fauxProvider({ provider: "subagent-test", models: [{ id: "parent" }, { id: "child" }], tokensPerSecond: 0 });
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const tools = ["read", "write", "mcp_custom"].map(name => defineTool({ name, description: name, parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: `${name} worked` }] }),
  }));
  registry.install(defineExtension({ name: "fixture-tools", tools: [...tools, ...extraTools] }));
  let active: Harness;
  const children: DurableSubagentChild[] = [];
  const subagent = createDurableSubagentExtension({
    getHarness: () => active, readLimits: () => ({}), readConcurrency: () => 3,
    isProjectTrusted: () => true, onChild: child => { children.push(child); }, ...options,
  });
  registry.install(subagent);
  async function open() {
    active = await Harness.open(await openNodeSqliteStorage(join(directory, "harness.sqlite")), {
      models: models as unknown as HarnessOptions["models"], registry,
      settings: { compaction: { enabled: false }, retry: { enabled: false } },
    }, context);
    harnesses.add(active);
    const root = await active.root(context, { agent: { cwd: directory, model: { provider: "subagent-test", modelId: "parent" } } });
    return { harness: active, root };
  }
  return { directory, faux, registry, children, subagent, open, ...await open() };
}

async function close(harness: Harness) { await harness.close(context); harnesses.delete(harness); }
afterEach(async () => {
  for (const harness of [...harnesses]) await close(harness);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function userText(transcript: TranscriptContext): string {
  return transcript.messages.filter(message => message.role === "user").map(message => typeof message.content === "string" ? message.content
    : message.content.filter(block => block.type === "text").map(block => block.type === "text" ? block.text : "").join("\n")).join("\n");
}

function isChild(transcript: TranscriptContext) { return userText(transcript).includes("<delegated_role"); }
function toolResult(transcript: TranscriptContext, name = "subagent") {
  return transcript.messages.findLast(message => message.role === "toolResult" && message.toolName === name);
}
function delegate(params: Parameters<typeof fauxToolCall>[1], child: FauxResponseFactory): FauxResponseFactory {
  return async (transcript, options, state, model) => {
    if (isChild(transcript)) return child(transcript, options, state, model);
    if (!toolResult(transcript)) return fauxAssistantMessage(fauxToolCall("subagent", params), { stopReason: "toolUse" });
    return fauxAssistantMessage("Parent incorporated the delegated result");
  };
}
async function completed(root: Conversation) {
  const settled = await (await root.submit({ type: "input", content: "Delegate the fixture", requestId: "fixture" }, context)).wait(context);
  expect(settled.status).toBe("done");
  const messages = (await root.entries({}, 100, undefined, context)).items.flatMap(entry => entry.model ?? []);
  const result = messages.find(message => message.role === "toolResult" && message.toolName === "subagent");
  if (result?.role !== "toolResult") throw new Error("Subagent result missing");
  return result as typeof result & { details: { mode: string; runs: DurableSubagentChild[]; usage: { inputTokens: number; outputTokens: number; cost: number } } };
}

describe("native Durable subagents", () => {
  it("checks live limits at the execution boundary when a safe child tool is replayed after restart", async () => {
    let trusted = true, executions = 0;
    const probe = defineTool({ name: "safe_probe", description: "A harmless replay-safe fixture", parameters: Type.Object({}), replay: "safe",
      execute: async (_args, api, callContext) => {
        await check(api, callContext);
        executions++;
        if (executions === 1) await new Promise<void>((resolve) => callContext.abortSignal?.addEventListener("abort", () => resolve(), { once: true }));
        return { content: [{ type: "text", text: "Probe complete" }] };
      },
    });
    const f = await fixture({ isProjectTrusted: () => trusted }, [probe]);
    const check = f.subagent.checkExecution;
    f.faux.setResponses(Array(12).fill(delegate({ agent: "worker", task: "Replay probe" }, () => fauxAssistantMessage(fauxToolCall("safe_probe", {}), { stopReason: "toolUse" }))));
    await f.root.submit({ type: "input", content: "Delegate the fixture", requestId: "fixture" }, context);
    await vi.waitFor(() => expect(executions).toBe(1));
    await close(f.harness);
    trusted = false;
    const resumed = await f.open();
    const result = await completed(resumed.root);
    expect(result.isError).toBe(true);
    expect(executions).toBe(1);
    expect(result.details.runs[0].error).toContain("trusted");
    const child = await resumed.harness.conversation(result.details.runs[0].conversationId as ConversationId, context);
    expect(JSON.stringify((await child!.entries({}, 100, undefined, context)).items)).toContain("Workspace is no longer trusted");
  });

  it("prepares per-child host services before the first provider call and only once per host", async () => {
    const prepared: number[] = [];
    const beforeChild = vi.fn(async (id: number) => {
      const configured = await f.harness.conversation(id as ConversationId, context);
      expect((await configured!.agent(context)).cwd).toBe(f.directory);
      prepared.push(id);
    });
    const f = await fixture({ beforeChild });
    f.faux.setResponses(Array(10).fill(delegate({ agent: "worker", task: "Read fixture" }, transcript => {
      expect(prepared).toHaveLength(1);
      if (!toolResult(transcript, "read")) return fauxAssistantMessage(fauxToolCall("read", {}), { stopReason: "toolUse" });
      return fauxAssistantMessage("Read with prepared services");
    })));
    const result = await completed(f.root);
    expect(result.isError).toBe(false);
    expect(beforeChild).toHaveBeenCalledExactlyOnceWith(result.details.runs[0].conversationId);
  });

  it("fails a child preparation without calling its provider or hiding the error", async () => {
    const f = await fixture({ beforeChild: () => { throw new Error("Child memory services unavailable"); } });
    let calls = 0;
    f.faux.setResponses(Array(8).fill(delegate({ agent: "worker", task: "Read fixture" }, () => { calls++; return fauxAssistantMessage("Must not run"); })));
    const result = await completed(f.root);
    expect(result.isError).toBe(true);
    expect(calls).toBe(0);
    expect(result.details.runs[0]).toMatchObject({ status: "failed", error: "Child memory services unavailable" });
    expect(f.children.at(-1)?.status).toBe("failed");
  });

  it("returns the real child answer/report and intersects inherited tools without enabling recursion", async () => {
    let offered: string[] = [], chosenModel = "";
    const f = await fixture({ discover: () => BUILTIN_SUBAGENTS.map(agent => ({ ...agent, tools: [...agent.tools],
      ...(agent.name === "worker" ? { model: "subagent-test/child" } : {}) })) });
    const response = delegate({ agent: "worker", task: "Inspect exact fixture", tools: ["read", "mcp_custom", "subagent", "missing"] }, (transcript, _options, _state, model) => {
      offered = getCurrentTools(transcript.messages).map(tool => tool.name);
      chosenModel = model.id;
      return fauxAssistantMessage("The exact fixture passed with evidence");
    });
    f.faux.setResponses(Array(10).fill(response));
    const result = await completed(f.root);
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "The exact fixture passed with evidence" }]);
    expect(result.details.mode).toBe("single");
    expect(result.details.runs[0]).toMatchObject({ agent: "worker", status: "completed", cwd: f.directory, tools: ["read", "mcp_custom"],
      report: { summary: "The exact fixture passed with evidence" } });
    expect(result.details.usage.inputTokens).toBeGreaterThan(0);
    expect(result.details.usage.outputTokens).toBeGreaterThan(0);
    expect(result.usage).toBeUndefined();
    expect(offered).toEqual(["read", "mcp_custom"]);
    expect(chosenModel).toBe("child");
    expect(f.children.at(-1)?.status).toBe("completed");
    const childId = result.details.runs[0].conversationId as ConversationId;
    expect((await f.harness.snapshot(DurableSubagentDoc, childId, context))?.ownerTaskId).toBeGreaterThan(0);
    expect((await f.harness.snapshot(UsageDoc, f.root.id, context))?.tools).toEqual({});
  });

  it("runs independent children in parallel up to the configured concurrency and preserves input order", async () => {
    const f = await fixture({ readConcurrency: () => 2 });
    let active = 0, peak = 0;
    const releases: Array<() => void> = [];
    const response = delegate({ tasks: ["First", "Second", "Third"].map(task => ({ agent: "worker", task })) }, async transcript => {
      active++; peak = Math.max(peak, active);
      await new Promise<void>(resolve => releases.push(resolve));
      active--;
      const task = ["First", "Second", "Third"].find(value => userText(transcript).includes(value));
      return fauxAssistantMessage(`${task} result`);
    });
    f.faux.setResponses(Array(12).fill(response));
    const running = completed(f.root);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(active).toBe(2);
    releases[1]();
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    releases[2](); releases[0]();
    const result = await running;
    expect(result.isError).toBe(false);
    expect(peak).toBe(2);
    expect(result.details.runs.map(child => child.task)).toEqual(["First", "Second", "Third"]);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("3/3 subagents completed") });
  });

  it("resumes a chain with the same children and does not repeat its completed first link", async () => {
    const f = await fixture();
    let firstCalls = 0, secondCalls = 0, hold = true;
    const response = delegate({ chain: [{ agent: "scout", task: "First link" }, { agent: "worker", task: "Second link uses {previous}" }] }, async (transcript, options) => {
      if (userText(transcript).includes("First link")) { firstCalls++; return fauxAssistantMessage("Evidence: file.ts"); }
      secondCalls++;
      expect(userText(transcript)).toContain("Second link uses Evidence: file.ts");
      if (hold) return new Promise(resolve => options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true }));
      return fauxAssistantMessage("Implemented from persisted evidence");
    });
    f.faux.setResponses(Array(15).fill(response));
    await f.root.submit({ type: "input", content: "Delegate the fixture", requestId: "fixture" }, context);
    await vi.waitFor(() => expect(secondCalls).toBe(1));
    const beforeIds = [...new Set(f.children.map(child => child.conversationId))];
    expect(beforeIds).toHaveLength(2);
    await close(f.harness);
    hold = false;
    const reopened = await f.open();
    const result = await completed(reopened.root);
    expect(result.isError).toBe(false);
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(2); // only the interrupted model request is retried
    expect(result.content).toEqual([{ type: "text", text: "Implemented from persisted evidence" }]);
    expect(result.details.runs.map(child => child.conversationId)).toEqual(beforeIds);
    for (const id of beforeIds) {
      const child = await reopened.harness.conversation(id as ConversationId, context);
      const entries = (await child!.entries({}, 100, undefined, context)).items;
      expect(entries.flatMap(entry => entry.model ?? []).filter(message => message.role === "user")).toHaveLength(1);
    }
  });

  it("shares a user turn ceiling across parallel children and cannot raise it through allocations", async () => {
    const f = await fixture({ readLimits: () => ({ maxTurns: 1 }), readConcurrency: () => 2 });
    let childCalls = 0;
    const response = delegate({ limits: { maxTurns: 99 }, tasks: ["A", "B"].map(task => ({ agent: "worker", task, limits: { maxTurns: 99 } })) }, () => {
      childCalls++; return fauxAssistantMessage("The single allocated turn completed");
    });
    f.faux.setResponses(Array(10).fill(response));
    const result = await completed(f.root);
    expect(result.isError).toBe(true);
    expect(childCalls).toBe(1);
    expect(result.details.runs.map(child => child.status).sort()).toEqual(["completed", "failed"]);
    expect(result.details.runs.find(child => child.status === "failed")?.error).toContain("shared turn limit");
  });

  it("counts native tool spend in the shared cost cap and blocks the next provider request", async () => {
    const spend = defineTool({ name: "spend", description: "Consume fixture cost", parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "Paid fixture action finished" }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.05 } } }),
    });
    const f = await fixture({ readLimits: () => ({ maxCostUsd: 0.01 }) }, [spend]);
    let childCalls = 0;
    const response = delegate({ agent: "worker", task: "Use the fixture cost tool" }, () => {
      childCalls++; return fauxAssistantMessage(fauxToolCall("spend", {}), { stopReason: "toolUse" });
    });
    f.faux.setResponses(Array(10).fill(response));
    const result = await completed(f.root);
    expect(result.isError).toBe(true);
    expect(childCalls).toBe(1);
    expect(result.details.runs[0]).toMatchObject({ status: "failed", error: expect.stringContaining("cost limit"), report: { usage: { cost: 0.05 } } });
    const total = await f.harness.usage(context);
    expect(total.tools.spend.cost.total).toBe(0.05);
    expect(total.tools.subagent).toBeUndefined();
  });

  it("stops a silent child at the saved wall-clock deadline", async () => {
    const f = await fixture({ readLimits: () => ({ timeoutMs: 150 }) });
    let aborted = false;
    f.faux.setResponses(Array(10).fill(delegate({ agent: "worker", task: "Wait forever" }, (_transcript, options) => new Promise(resolve => {
      options?.signal?.addEventListener("abort", () => { aborted = true; resolve(fauxAssistantMessage("", { stopReason: "aborted" })); }, { once: true });
    }))));
    const result = await completed(f.root);
    expect(aborted).toBe(true);
    expect(result.isError).toBe(true);
    expect(result.details.runs[0]).toMatchObject({ status: "failed", error: expect.stringContaining("time limit") });
  });

  it("cancels owned child work and does not start queued children after the parent aborts", async () => {
    const f = await fixture({ readConcurrency: () => 1 });
    let childCalls = 0;
    f.faux.setResponses(Array(10).fill(delegate({ tasks: ["A", "B", "C"].map(task => ({ agent: "worker", task })) }, (_transcript, options) => {
      childCalls++;
      return new Promise(resolve => options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true }));
    })));
    const submission = await f.root.submit({ type: "input", content: "Delegate", requestId: "cancel" }, context);
    await vi.waitFor(() => expect(childCalls).toBe(1));
    await f.root.abort(context);
    expect(await submission.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
    expect(childCalls).toBe(1);
    expect((await f.harness.inspect(context)).tasks).toHaveLength(0);
    await close(f.harness);
    const reopened = await f.open();
    expect((await reopened.harness.inspect(context)).tasks).toHaveLength(0);
    expect(childCalls).toBe(1);
  });

  it("refuses untrusted project delegation without spawning children", async () => {
    const f = await fixture({ isProjectTrusted: () => false });
    let childCalls = 0;
    f.faux.setResponses(Array(8).fill(delegate({ agent: "worker", task: "Write", confirmProjectAgents: false }, () => {
      childCalls++; return fauxAssistantMessage("Must not run");
    })));
    const result = await completed(f.root);
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("not trusted") });
    expect(childCalls).toBe(0);
    expect(f.children).toEqual([]);
  });

  it.each([
    { request: { agent: "unknown", task: "Inspect" }, error: "Unknown subagent" },
    { request: { agent: "worker", task: "Inspect", tasks: [{ agent: "worker", task: "Extra" }] }, error: "exactly one" },
  ])("rejects an invalid delegation request: $error", async ({ request, error }) => {
    const f = await fixture();
    f.faux.setResponses(Array(5).fill(delegate(JSON.parse(JSON.stringify(request)), () => fauxAssistantMessage("Must not run"))));
    const result = await completed(f.root);
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining(error) });
    expect(f.children).toEqual([]);
  });

  it("keeps a model's recursive delegation attempt from creating a grandchild", async () => {
    const f = await fixture();
    let childCalls = 0;
    f.faux.setResponses(Array(10).fill(delegate({ agent: "worker", task: "Try forbidden delegation" }, transcript => {
      childCalls++;
      if (!toolResult(transcript)) return fauxAssistantMessage(fauxToolCall("subagent", { agent: "worker", task: "Recursive" }), { stopReason: "toolUse" });
      expect(toolResult(transcript)).toMatchObject({ isError: true });
      return fauxAssistantMessage("Completed without recursive delegation");
    })));
    const result = await completed(f.root);
    expect(result.isError).toBe(false);
    expect(childCalls).toBe(2);
    expect(new Set(f.children.map(child => child.conversationId)).size).toBe(1);
  });

  it("fails closed when a live trust guard throws, before paying for a child model call", async () => {
    let trustReads = 0, childCalls = 0;
    const f = await fixture({ isProjectTrusted: () => {
      if (++trustReads > 1) throw new Error("Trust service unavailable");
      return true;
    } });
    f.faux.setResponses(Array(8).fill(delegate({ agent: "worker", task: "Inspect" }, () => {
      childCalls++; return fauxAssistantMessage("Must not run");
    })));
    const result = await completed(f.root);
    expect(result.isError).toBe(true);
    expect(childCalls).toBe(0);
    expect(result.details.runs[0]).toMatchObject({ status: "failed", error: expect.stringContaining("Trust service unavailable") });
  });
});
