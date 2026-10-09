import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  configure, createRegistry, defineExtension, defineTool, Harness,
  type Conversation, type HarnessOptions,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai-durable";

// Capability experiment only: no product adapter, real credentials or services.
// The owned-child pattern is the official Durable 1.0 README's subagent example.
const context = BACKGROUND_CONTEXT;
const directories: string[] = [];
const opened = new Set<Harness>();

afterEach(async () => {
  for (const harness of opened) await harness.close(context);
  opened.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(labels: string[]) {
  const directory = mkdtempSync(join(tmpdir(), "pi-durable-owned-subagents-"));
  directories.push(directory);
  const faux = fauxProvider({
    provider: "owned-subagent-audit", models: [{ id: "parent" }, { id: "worker" }], tokensPerSecond: 0,
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const waiting = new Map<string, () => void>();
  const aborted = new Set<string>();
  const createdChildren: string[] = [];
  const toolInvocations: string[] = [];
  const modelRequests: string[] = [];
  let holdWorkers = true;

  const responder: FauxResponseFactory = async (transcript, options, _state, model) => {
    modelRequests.push(model.id);
    if (model.id === "parent") {
      const results = transcript.messages.filter(message => message.role === "toolResult");
      if (results.length) {
        const completed = results.length === labels.length && labels.every(label => results.some(result =>
          result.toolCallId === `call-${label}` && !result.isError
          && result.content.some(block => block.type === "text" && block.text === `Child ${label} completed`)));
        return completed ? fauxAssistantMessage("All owned children settled.")
          : fauxAssistantMessage("Delegation did not complete successfully", { stopReason: "error" });
      }
      return fauxAssistantMessage(labels.map(label => fauxToolCall("delegate", { label }, { id: `call-${label}` })), { stopReason: "toolUse" });
    }
    const user = transcript.messages.find(message => message.role === "user");
    const label = typeof user?.content === "string" ? user.content
      : user?.content.filter(block => block.type === "text").map(block => block.text).join("") ?? "unknown";
    if (holdWorkers) {
      await new Promise<void>(resolve => {
        const onAbort = () => { aborted.add(label); resolve(); };
        waiting.set(label, () => {
          options?.signal?.removeEventListener("abort", onAbort);
          resolve();
        });
        if (options?.signal?.aborted) onAbort();
        else options?.signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    return options?.signal?.aborted
      ? fauxAssistantMessage("", { stopReason: "aborted" })
      : fauxAssistantMessage(`Finished ${label}`);
  };
  faux.setResponses(Array.from({ length: 20 }, () => responder));

  const registry = createRegistry();
  registry.install(defineExtension({ name: "owned-subagent-audit", tools: [defineTool({
    name: "delegate", description: "Delegate one independent fixture task", parameters: Type.Object({ label: Type.String() }),
    replay: "safe", executionMode: "parallel",
    async execute(args, api, callContext) {
      toolInvocations.push(String(api.taskId));
      const childId = await api.commit(async tx => {
        const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
        if (existing) return existing.id;
        const child = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
        await configure(tx, child.id, { model: { provider: "owned-subagent-audit", modelId: "worker" }, tools: [] });
        createdChildren.push(String(child.id));
        return child.id;
      }, callContext);
      await api.details({ conversationId: childId }, callContext);
      const child = await api.conversation(childId, callContext);
      if (!child) throw new Error("Owned child was not persisted");
      const submission = await child.submit({ type: "input", content: args.label, requestId: `delegate:${api.taskId}` }, callContext);
      const settled = await submission.wait(callContext);
      if (settled.status !== "done") throw new Error(`Child ${args.label} did not complete`);
      return { content: [{ type: "text", text: `Child ${args.label} completed` }], details: { conversationId: childId } };
    },
  })] }));

  async function open() {
    const storage = await openNodeSqliteStorage(join(directory, "session.sqlite"));
    const harness = await Harness.open(storage, {
      models: models as unknown as HarnessOptions["models"], registry,
      settings: { toolExecution: "parallel", compaction: { enabled: false }, retry: { enabled: false } },
    }, context);
    opened.add(harness);
    const root = await harness.root(context, { agent: { model: { provider: "owned-subagent-audit", modelId: "parent" } } });
    return { harness, root };
  }
  async function close(harness: Harness) {
    await harness.close(context);
    opened.delete(harness);
  }
  return { open, close, waiting, aborted, createdChildren, toolInvocations, modelRequests, releaseFutureWorkers: () => { holdWorkers = false; } };
}

async function users(conversation: Conversation) {
  return (await conversation.entries({}, 100, undefined, context)).items
    .flatMap(entry => entry.model ?? []).filter(message => message.role === "user");
}

async function expectSuccessfulChildren(harness: Harness, root: Conversation, labels: string[]) {
  const parentContext = await root.context(context);
  const results = parentContext.messages.filter(message => message.role === "toolResult");
  expect(results).toHaveLength(labels.length);
  for (const label of labels) {
    const result = results.find(message => message.toolCallId === `call-${label}`);
    expect(result).toBeDefined();
    expect(result!.isError).toBe(false);
    expect(result!.content).toEqual([{ type: "text", text: `Child ${label} completed` }]);
  }
  const children = await harness.commit(tx => tx.scanConversations({ ownerConversationId: root.id }, 10), context);
  expect(children.items).toHaveLength(labels.length);
  const completedLabels: string[] = [];
  for (const record of children.items) {
    const child = await harness.conversation(record.id, context);
    const messages = (await child!.context(context)).messages;
    const user = messages.find(message => message.role === "user");
    const label = typeof user?.content === "string" ? user.content
      : user?.content.filter(block => block.type === "text").map(block => block.text).join("");
    const finalAssistant = messages.findLast(message => message.role === "assistant");
    expect(finalAssistant).toMatchObject({
      role: "assistant", stopReason: "stop", content: [{ type: "text", text: `Finished ${label}` }],
    });
    completedLabels.push(label!);
  }
  expect(completedLabels.sort()).toEqual([...labels].sort());
}

describe("official Durable owned-subagent capability audit (SQLite, offline faux model)", () => {
  it("starts independent owned children in parallel before either child completes", async () => {
    const input = fixture(["alpha", "beta"]);
    const { harness, root } = await input.open();
    const submission = await root.submit({ type: "input", content: "Delegate independent work", requestId: "parallel-parent" }, context);
    await vi.waitFor(() => expect(input.waiting.size).toBe(2));
    expect(input.createdChildren).toHaveLength(2);
    expect(new Set(input.toolInvocations).size).toBe(2);
    const children = await harness.commit(tx => tx.scanConversations({ ownerConversationId: root.id }, 10), context);
    expect(children.items).toHaveLength(2);
    // Resolving the second first proves this is not a sequential queue in disguise.
    input.waiting.get("beta")!();
    input.waiting.get("alpha")!();
    expect((await submission.wait(context)).status).toBe("done");
    expect(input.modelRequests.filter(id => id === "worker")).toHaveLength(2);
    const contextView = await root.context(context);
    expect(contextView.messages.filter(message => message.role === "toolResult").map(message => message.toolCallId))
      .toEqual(["call-alpha", "call-beta"]);
    await expectSuccessfulChildren(harness, root, ["alpha", "beta"]);
  });

  it("aborting the parent cancels both owned children and stays cancelled after reopen", async () => {
    const input = fixture(["alpha", "beta"]);
    const first = await input.open();
    const submission = await first.root.submit({ type: "input", content: "Delegate then cancel", requestId: "cancel-parent" }, context);
    await vi.waitFor(() => expect(input.waiting.size).toBe(2));
    await first.root.abort(context);
    expect(input.aborted).toEqual(new Set(["alpha", "beta"]));
    expect((await submission.wait(context)).status).toBe("unanswered");
    expect((await first.harness.inspect(context)).tasks).toHaveLength(0);
    const requestsBefore = input.modelRequests.length;
    await input.close(first.harness);
    const reopened = await input.open();
    const retried = await reopened.root.submit({ type: "input", content: "Delegate then cancel", requestId: "cancel-parent" }, context);
    expect((await retried.wait(context)).status).toBe("unanswered");
    expect(input.modelRequests).toHaveLength(requestsBefore);
    expect(input.createdChildren).toHaveLength(2);
  });

  it("close/reopen replays the same delegation task and resumes the same child/input without redispatch", async () => {
    const input = fixture(["alpha"]);
    const first = await input.open();
    const original = await first.root.submit({ type: "input", content: "Recover owned work", requestId: "recover-parent" }, context);
    await vi.waitFor(() => expect(input.waiting.size).toBe(1));
    const childId = input.createdChildren[0];
    const toolTaskId = input.toolInvocations[0];
    await input.close(first.harness);
    input.releaseFutureWorkers();
    const reopened = await input.open();
    const resumed = await reopened.root.submit({ type: "input", content: "Recover owned work", requestId: "recover-parent" }, context);
    expect(resumed.id).toBe(original.id);
    expect((await resumed.wait(context)).status).toBe("done");
    expect(input.createdChildren).toEqual([childId]);
    expect(input.toolInvocations).toEqual([toolTaskId, toolTaskId]);
    const children = await reopened.harness.commit(tx => tx.scanConversations({ ownerConversationId: reopened.root.id }, 10), context);
    expect(children.items.map(child => String(child.id))).toEqual([childId]);
    const child = await reopened.harness.conversation(children.items[0].id, context);
    expect(await users(child!)).toHaveLength(1);
    expect(await users(reopened.root)).toHaveLength(1);
    // A interrupted model request may resend; durable ownership is not exactly-once billing.
    expect(input.modelRequests.filter(id => id === "worker")).toHaveLength(2);
    await expectSuccessfulChildren(reopened.harness, reopened.root, ["alpha"]);
  });
});
