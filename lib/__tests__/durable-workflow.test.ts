import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry, defineExtension, defineTool, GenerationTask, Harness,
  type GenerationHooks, type HarnessOptions,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type, type FauxContentBlock } from "@earendil-works/pi-ai-durable";
import {
  createDurableWorkflowExtension, DurableWorkflowDoc, durableWorkflowUIEvents,
  handleDurableWorkflowCommand, pauseDurableWorkflow, readDurableWorkflow,
} from "../durable-workflow";

const context = BACKGROUND_CONTEXT;
const directories: string[] = [];
const live = new Set<Harness>();
afterEach(async () => {
  for (const harness of live) await harness.close(context);
  live.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function response(content: string | FauxContentBlock | FauxContentBlock[], toolUse = false) {
  return fauxAssistantMessage(content, { stopReason: toolUse ? "toolUse" : "stop" });
}

async function fixture(options: { holdFirstYield?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "pi-durable-workflow-"));
  directories.push(directory);
  const faux = fauxProvider({ provider: "durable-workflow-fixture", models: [{ id: "offline" }], tokensPerSecond: 0 });
  const models = createModels();
  models.setProvider(faux.provider);
  let harness: Harness;
  let blockReason: string | undefined;
  let yieldHeld = false;
  let heldOnce = false;
  const registry = createRegistry();
  const workflow = createDurableWorkflowExtension({ harness: () => harness, beforeRequest: request => { blockReason = request.blockReason; } });
  registry.install({ ...workflow, hooks: workflow.hooks?.map(registration => {
    if (!options.holdFirstYield || registration.task !== GenerationTask.definition.name) return registration;
    const handlers = registration.handlers as Partial<GenerationHooks>;
    return { ...registration, handlers: { ...handlers, onYield: (async (answer, api, callContext) => {
      const result = await handlers.onYield?.(answer, api, callContext);
      if (result?.continue && !heldOnce) {
        heldOnce = true; yieldHeld = true;
        // Interrupt after our durable receipt, before the native generation commits its continuation.
        await new Promise<void>(resolve => {
          if (callContext.abortSignal?.aborted) resolve();
          else callContext.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      return result;
    }) satisfies GenerationHooks["onYield"] } };
  }) });
  const writes = vi.fn(async () => ({ content: [{ type: "text" as const, text: "Written" }] }));
  const shells = vi.fn(async () => ({ content: [{ type: "text" as const, text: "Inspected" }] }));
  registry.install(defineExtension({ name: "fixture-files", tools: [
    defineTool({ name: "write", description: "Fixture write", parameters: Type.Object({}), execute: writes }),
    defineTool({ name: "bash", description: "Fixture shell", parameters: Type.Object({ command: Type.String() }), execute: shells }),
  ] }));
  const guardedModels = new Proxy(models, {
    get(target, key) {
      if (key === "streamSimple") return (...args: Parameters<typeof target.streamSimple>) => {
        if (blockReason) throw new Error(blockReason);
        return target.streamSimple(...args);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const open = async () => {
    harness = await Harness.open(await openNodeSqliteStorage(join(directory, "session.sqlite")), {
      models: guardedModels as unknown as HarnessOptions["models"], registry,
      settings: { compaction: { enabled: false }, retry: { enabled: false } },
    }, context);
    live.add(harness);
    const root = await harness.root(context, { agent: { model: { provider: "durable-workflow-fixture", modelId: "offline" } } });
    return { harness, root };
  };
  const close = async () => { await harness.close(context); live.delete(harness); };
  return { ...await open(), open, close, faux, writes, shells, yieldHeld: () => yieldHeld };
}

describe("native Durable Goal, Plan and structured output on SQLite", () => {
  it("continues a goal once per durable yield and completes through the official tool", async () => {
    const f = await fixture();
    f.faux.setResponses([
      response("Inspected the task"),
      async () => response(fauxToolCall("goal_status", { goalId: (await readDurableWorkflow(f.harness, f.root.id)).goal!.id, status: "complete", evidence: "Verified the fixture outcome." }), true),
      response("Verified and complete"),
    ]);
    expect(await handleDurableWorkflowCommand(f.root, f.harness, "/goal Verify the fixture")).toBe(true);
    await f.harness.waitForIdle(context);
    const state = await readDurableWorkflow(f.harness, f.root.id);
    expect(state.goal).toMatchObject({ status: "complete", automaticRuns: 1 });
    const actualTokens = (await f.root.context(context)).messages.reduce((sum, message) => sum + (message.role === "assistant" ? message.usage.input + message.usage.output : 0), 0);
    expect(state.goal?.tokens).toBe(actualTokens);
    expect(actualTokens).toBeGreaterThan(0);
    expect(f.faux.state.callCount).toBe(3);
    const document = await f.harness.snapshot(DurableWorkflowDoc, f.root.id, context);
    expect(Object.keys(document!.continuations)).toHaveLength(1);
    expect(durableWorkflowUIEvents(state)).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "setWidget", widgetKey: "Goal", widgetLines: undefined }),
    ]));
    await f.close();
    const reopened = await f.open();
    expect((await readDurableWorkflow(reopened.harness, reopened.root.id)).goal).toEqual(state.goal);
    expect((await reopened.harness.inspect(context)).tasks).toHaveLength(0);
    expect(f.faux.state.callCount).toBe(3);
  });

  it("explicit pause and stop never trigger an automatic continuation, including after reopen", async () => {
    const f = await fixture();
    let finish!: () => void;
    f.faux.setResponses([async () => { await new Promise<void>(resolve => { finish = resolve; }); return response("Current response finished"); }]);
    await handleDurableWorkflowCommand(f.root, f.harness, "/goal Finish later");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await handleDurableWorkflowCommand(f.root, f.harness, "/goal pause");
    finish();
    await f.harness.waitForIdle(context);
    expect((await readDurableWorkflow(f.harness, f.root.id)).goal).toMatchObject({ status: "paused", automaticRuns: 0 });
    f.faux.setResponses([async (_transcript, options) => {
      await new Promise<void>(resolve => { options?.signal?.addEventListener("abort", () => resolve(), { once: true }); });
      return fauxAssistantMessage("", { stopReason: "aborted" });
    }]);
    await handleDurableWorkflowCommand(f.root, f.harness, "/goal resume");
    await vi.waitFor(() => expect(f.faux.state.callCount).toBe(2));
    await pauseDurableWorkflow(f.root, "Stopped by user.");
    await f.root.abort(context);
    await f.close();
    const reopened = await f.open();
    expect((await readDurableWorkflow(reopened.harness, reopened.root.id)).goal?.status).toBe("paused");
    expect((await reopened.harness.inspect(context)).tasks).toHaveLength(0);
    expect(f.faux.state.callCount).toBe(2);
  });

  it("recovers a committed yield receipt without counting or submitting the continuation twice", async () => {
    const f = await fixture({ holdFirstYield: true });
    f.faux.setResponses([response("Inspected the task")]);
    await handleDurableWorkflowCommand(f.root, f.harness, "/goal Recover an interrupted yield");
    await vi.waitFor(() => expect(f.yieldHeld()).toBe(true));
    expect((await readDurableWorkflow(f.harness, f.root.id)).goal?.automaticRuns).toBe(1);
    await f.close();
    const reopened = await f.open();
    f.faux.setResponses([
      response("Inspected the task"),
      async () => response(fauxToolCall("goal_status", { goalId: (await readDurableWorkflow(reopened.harness, reopened.root.id)).goal!.id, status: "complete", evidence: "Recovered and verified the fixture." }), true),
      response("Recovered successfully"),
    ]);
    reopened.harness.resume();
    await reopened.harness.waitForIdle(context);
    expect((await readDurableWorkflow(reopened.harness, reopened.root.id)).goal).toMatchObject({ status: "complete", automaticRuns: 1 });
    const users = (await reopened.root.context(context)).messages.filter(message => message.role === "user");
    expect(users).toHaveLength(2);
    expect(Object.keys((await reopened.harness.snapshot(DurableWorkflowDoc, reopened.root.id, context))!.continuations)).toHaveLength(1);
  });

  it("persists the token budget and prevents a tool action and a further provider call", async () => {
    const f = await fixture();
    f.faux.setResponses([response(fauxToolCall("write", {}), true), response("Must not be requested")]);
    await handleDurableWorkflowCommand(f.root, f.harness, "/goal --tokens 10 Budget fixture");
    await f.harness.waitForIdle(context);
    const limited = (await readDurableWorkflow(f.harness, f.root.id)).goal!;
    expect(limited.status).toBe("budget_limited");
    expect(limited.tokens).toBeGreaterThanOrEqual(10);
    expect(f.writes).not.toHaveBeenCalled();
    expect(f.faux.state.callCount).toBe(1);
    await expect(handleDurableWorkflowCommand(f.root, f.harness, "/goal resume")).rejects.toThrow("Token budget");
    await f.close();
    const reopened = await f.open();
    expect((await readDurableWorkflow(reopened.harness, reopened.root.id)).goal?.tokens).toBe(limited.tokens);
    await handleDurableWorkflowCommand(reopened.root, reopened.harness, "/goal budget 100k");
    await handleDurableWorkflowCommand(reopened.root, reopened.harness, "/goal runs 1");
    f.faux.setResponses([response("Progress one"), response("Progress two")]);
    await handleDurableWorkflowCommand(reopened.root, reopened.harness, "/goal resume");
    await reopened.harness.waitForIdle(context);
    expect((await readDurableWorkflow(reopened.harness, reopened.root.id)).goal).toMatchObject({ status: "paused", tokenBudget: 100000, automaticRuns: 1 });
    expect((await readDurableWorkflow(reopened.harness, reopened.root.id)).goal!.tokens).toBeGreaterThan(limited.tokens);
  });

  it("pauses repeated no-progress output and honors explicit continuation limits", async () => {
    const f = await fixture();
    f.faux.setResponses(Array.from({ length: 5 }, () => response("Still working")));
    await handleDurableWorkflowCommand(f.root, f.harness, "/goal Detect repeated output");
    await f.harness.waitForIdle(context);
    expect(f.faux.state.callCount).toBe(4);
    expect((await readDurableWorkflow(f.harness, f.root.id)).goal).toMatchObject({ status: "paused", automaticRuns: 3, reason: expect.stringContaining("Repeated") });
    await handleDurableWorkflowCommand(f.root, f.harness, "/goal runs 0");
    expect((await readDurableWorkflow(f.harness, f.root.id)).goal?.automaticRunLimit).toBe(0);
    await handleDurableWorkflowCommand(f.root, f.harness, "/goal clear");
    expect((await readDurableWorkflow(f.harness, f.root.id)).goal).toBeNull();
  });

  it("blocks writes and unsafe shell during planning, then restores the reviewed execution tools", async () => {
    const f = await fixture();
    const originalTools = (await f.root.agent(context)).tools.map(tool => tool.name);
    f.faux.setResponses([
      response(fauxToolCall("write", {}), true),
      response(fauxToolCall("bash", { command: "touch forbidden" }), true),
      response(fauxToolCall("update_plan", { title: "Fixture plan", steps: [{ text: "Verify file", status: "pending" }] }), true),
      response("Review the plan"),
    ]);
    await handleDurableWorkflowCommand(f.root, f.harness, "/plan Verify file");
    await f.harness.waitForIdle(context);
    expect(f.writes).not.toHaveBeenCalled();
    expect(f.shells).not.toHaveBeenCalled();
    expect((await readDurableWorkflow(f.harness, f.root.id)).plan?.status).toBe("ready");
    expect((await f.root.agent(context)).tools.map(tool => tool.name)).not.toContain("write");
    const errors = (await f.root.context(context)).messages.filter(message => message.role === "toolResult" && message.isError);
    expect(errors).toHaveLength(2);
    f.faux.setResponses([
      response([fauxToolCall("write", {}), fauxToolCall("update_plan", { title: "Fixture plan", steps: [{ text: "Verify file", status: "completed" }] })], true),
      response("Verified execution"),
    ]);
    await handleDurableWorkflowCommand(f.root, f.harness, "/plan execute");
    await f.harness.waitForIdle(context);
    expect(f.writes).toHaveBeenCalledOnce();
    expect((await readDurableWorkflow(f.harness, f.root.id)).plan?.status).toBe("complete");
    expect((await f.root.agent(context)).tools.map(tool => tool.name)).toEqual(originalTools);
  });

  it("keeps branch-local plan state at the fork point and refinement/cancel preserve tools", async () => {
    const f = await fixture();
    f.faux.setResponses([
      response(fauxToolCall("update_plan", { title: "Original plan", steps: [{ text: "Original step", status: "pending" }] }), true), response("First review"),
    ]);
    await handleDurableWorkflowCommand(f.root, f.harness, "/plan Original plan");
    await f.harness.waitForIdle(context);
    const forkAt = (await f.root.entries({}, 1, undefined, context)).items[0].id;
    f.faux.setResponses([
      response(fauxToolCall("update_plan", { title: "Refined plan", steps: [{ text: "New step", status: "pending" }] }), true), response("Second review"),
    ]);
    await handleDurableWorkflowCommand(f.root, f.harness, "/plan refine Add a check");
    await f.harness.waitForIdle(context);
    const fork = await f.root.fork(forkAt, { ownership: { kind: "ownerless" } }, context);
    expect((await readDurableWorkflow(f.harness, fork.id)).plan?.title).toBe("Original plan");
    expect((await readDurableWorkflow(f.harness, f.root.id)).plan?.title).toBe("Refined plan");
    await handleDurableWorkflowCommand(fork, f.harness, "/plan cancel");
    expect((await readDurableWorkflow(f.harness, fork.id)).plan).toBeNull();
    expect((await fork.agent(context)).tools.map(tool => tool.name)).toContain("write");
    await f.close();
    const reopened = await f.open();
    expect((await readDurableWorkflow(reopened.harness, reopened.root.id)).plan?.title).toBe("Refined plan");
  });

  it("persists structured output details and terminates without a second model turn", async () => {
    const f = await fixture();
    f.faux.setResponses([response(fauxToolCall("structured_output", { headline: " Verified ", summary: "Fixture passed", actionItems: [" Done "], kind: "result" }), true)]);
    const submission = await f.root.submit({ type: "input", content: "Give the result card" }, context);
    expect((await submission.wait(context)).status).toBe("done");
    expect(f.faux.state.callCount).toBe(1);
    const entries = (await f.root.entries({}, 20, undefined, context)).items;
    expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({ model: expect.arrayContaining([expect.objectContaining({ role: "toolResult", toolName: "structured_output", details: { headline: "Verified", summary: "Fixture passed", actionItems: ["Done"], kind: "result" } })]) })]));
  });
});
