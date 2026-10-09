import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type,
  type TranscriptContext,
} from "@earendil-works/pi-ai-durable";
import {
  createRegistry, defineExtension, defineTool, Harness, watchEvents,
  type AgentEvent, type AgentEventStream, type Conversation, type HarnessOptions,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

// Pre-integration probes of the pinned, real SDK. No Pi Web runtime, production
// directory, credentials, network provider or mocked persistence participates.
const context = BACKGROUND_CONTEXT;
const directories: string[] = [];
const harnesses = new Set<Harness>();
const streams = new Set<AgentEventStream>();

function fixture(tokensPerSecond = 0) {
  const directory = mkdtempSync(join(tmpdir(), "pi-durable-chat-audit-"));
  directories.push(directory);
  const faux = fauxProvider({
    provider: "chat-audit", models: [{ id: "first" }, { id: "second" }],
    tokensPerSecond, tokenSize: { min: 1, max: 1 },
  });
  const models = createModels();
  models.setProvider(faux.provider);
  return {
    directory, faux, registry: createRegistry(),
    models: models as unknown as HarnessOptions["models"],
  };
}

async function open(input: ReturnType<typeof fixture>) {
  const storage = await openNodeSqliteStorage(join(input.directory, "session.sqlite"));
  const harness = await Harness.open(storage, {
    models: input.models, registry: input.registry,
    settings: { compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } },
  }, context);
  harnesses.add(harness);
  const root = await harness.root(context, { agent: { model: { provider: "chat-audit", modelId: "first" } } });
  return { harness, root };
}

async function close(harness: Harness) {
  await harness.close(context);
  harnesses.delete(harness);
}

async function observe(harness: Harness, conversation: Conversation) {
  const stream = await watchEvents(harness, conversation.id, context);
  streams.add(stream);
  const events: AgentEvent[] = [];
  stream.start(async batch => { events.push(...batch); });
  return { stream, events };
}

function text(messages: readonly { content: unknown }[]) {
  return messages.map(message => typeof message.content === "string" ? message.content
    : Array.isArray(message.content) ? message.content.map(block => block.text ?? block.thinking ?? "").join("") : "").join("\n");
}

function users(transcript: TranscriptContext) {
  return transcript.messages.filter(message => message.role === "user").map(message => text([message]));
}

async function history(conversation: Conversation) {
  return [...(await conversation.entries({}, 100, undefined, context)).items].reverse();
}

afterEach(async () => {
  for (const stream of streams) await stream.stop();
  streams.clear();
  for (const harness of [...harnesses]) await close(harness);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Pi Durable native chat capability audit", () => {
  it("streams committed text deltas and gives a late observer the in-flight snapshot", async () => {
    const input = fixture(35);
    const answer = "Committed streaming text reaches a late observer without losing the final answer.";
    input.faux.setResponses([fauxAssistantMessage(answer)]);
    const { harness, root } = await open(input);
    const early = await observe(harness, root);
    const submission = await root.submit({ type: "input", content: "Stream this", requestId: "stream" }, context);
    await vi.waitFor(() => expect(early.events.some(event => event.type === "message_update"
      && event.changes.some(change => change.type === "text_delta" && change.delta.length > 0))).toBe(true), { timeout: 2_000 });
    const late = await observe(harness, root);
    const partial = late.stream.snapshot.generation?.message;
    expect(late.stream.snapshot.run?.inputs).toContain(submission.id);
    expect(partial).toBeDefined();
    expect(text([partial!]).length).toBeGreaterThan(0);
    expect(text([partial!]).length).toBeLessThan(answer.length);
    expect((await submission.wait(context)).status).toBe("done");
    await vi.waitFor(() => expect(late.events.some(event => event.type === "run_end")).toBe(true));
    expect(late.events.filter(event => event.type === "message_end" && event.entry.kind === "pi.assistant")).toHaveLength(1);
    expect(text((await root.context(context)).messages)).toContain(answer);
    // Native updates are deltas, unlike the current Web reducer's full message.
    expect(early.events.find(event => event.type === "message_update")).not.toHaveProperty("message");
  }, 10_000);

  it("places a steer after the tool round, follows up after the answer, and withdraws a queued input", async () => {
    const input = fixture();
    let toolStarted = false;
    let releaseTool: () => void = () => {};
    const gate = new Promise<void>(resolve => { releaseTool = resolve; });
    input.registry.install(defineExtension({ name: "gate", tools: [defineTool({
      name: "gate", description: "Wait for the audit", parameters: Type.Object({}), replay: "safe",
      execute: async (_args, _api, callContext) => {
        toolStarted = true;
        callContext.abortSignal?.addEventListener("abort", releaseTool, { once: true });
        await gate;
        return { content: [{ type: "text", text: "Gate opened" }] };
      },
    })] }));
    const requests: string[][] = [];
    input.faux.setResponses([
      transcript => { requests.push(users(transcript)); return fauxAssistantMessage(fauxToolCall("gate", {}), { stopReason: "toolUse" }); },
      transcript => { requests.push(users(transcript)); return fauxAssistantMessage("Initial task and steer answered"); },
      transcript => { requests.push(users(transcript)); return fauxAssistantMessage("Follow-up answered"); },
    ]);
    const { root } = await open(input);
    const initial = await root.submit({ type: "input", content: "Initial task", requestId: "initial" }, context);
    await vi.waitFor(() => expect(toolStarted).toBe(true));
    const follow = await root.submit({ type: "input", content: "Follow-up task", requestId: "follow" }, context);
    const withdrawn = await root.submit({ type: "input", content: "Never deliver", requestId: "withdrawn" }, context);
    const steer = await root.submit({ type: "input", content: "Steering correction", whenBusy: "steer", requestId: "steer" }, context);
    await expect(root.submit({ type: "input", content: "Reject while busy", whenBusy: "reject" }, context)).rejects.toThrow();
    expect(await withdrawn.abort(context)).toBe("aborted");
    releaseTool();
    expect((await initial.wait(context)).status).toBe("done");
    expect((await steer.wait(context)).status).toBe("done");
    expect((await follow.wait(context)).status).toBe("done");
    expect(await withdrawn.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
    expect(requests).toEqual([
      ["Initial task"], ["Initial task", "Steering correction"],
      ["Initial task", "Steering correction", "Follow-up task"],
    ]);
    expect(text((await root.context(context)).messages)).not.toContain("Never deliver");
  });

  it("forks the historical model and context without leaking later parent or child messages", async () => {
    const input = fixture();
    const requestedModels: string[] = [];
    input.faux.setResponses(["First answer", "Parent later answer", "Child answer"].map(answer =>
      (_transcript, _options, _state, model) => { requestedModels.push(model.id); return fauxAssistantMessage(answer); }));
    const { root } = await open(input);
    const first = await (await root.submit({ type: "input", content: "Shared history" }, context)).wait(context);
    if (first.type !== "input" || first.status !== "done") throw new Error("First input was not answered");
    await root.configure({ model: { provider: "chat-audit", modelId: "second" } }, context);
    await (await root.submit({ type: "input", content: "Parent only" }, context)).wait(context);
    const child = await root.fork(first.answer, { ownership: { kind: "ownerless" } }, context);
    expect((await child.agent(context)).model).toEqual({ provider: "chat-audit", modelId: "first" });
    expect((await root.agent(context)).model).toEqual({ provider: "chat-audit", modelId: "second" });
    expect(text((await child.context(context)).messages)).toContain("Shared history");
    expect(text((await child.context(context)).messages)).not.toContain("Parent only");
    await (await child.submit({ type: "input", content: "Child only" }, context)).wait(context);
    expect(text((await root.context(context)).messages)).not.toContain("Child only");
    expect(requestedModels).toEqual(["first", "second", "first"]);
  });

  it("keeps reset history on disk while only the handoff and new context reach the model after reopen", async () => {
    const input = fixture();
    input.faux.setResponses([fauxAssistantMessage("Historical answer")]);
    const first = await open(input);
    await (await first.root.submit({ type: "input", content: "Old private context" }, context)).wait(context);
    const before = await history(first.root);
    await first.root.reset("Handoff note", context);
    const contextBeforeClose = await first.root.context(context);
    expect(contextBeforeClose.head?.kind).toBe("pi.reset");
    expect(text(contextBeforeClose.messages)).toContain("Handoff note");
    expect(text(contextBeforeClose.messages)).not.toContain("Old private context");
    await close(first.harness);
    const reopened = await open(input);
    expect(reopened.root.id).toBe(first.root.id);
    const restored = await history(reopened.root);
    expect(restored.map(entry => entry.id)).toEqual(expect.arrayContaining(before.map(entry => entry.id)));
    expect((await reopened.root.context(context)).head?.kind).toBe("pi.reset");
    input.faux.setResponses([transcript => {
      expect(users(transcript)).toEqual(["Handoff note", "Continue from handoff"]);
      return fauxAssistantMessage("New answer");
    }]);
    expect((await (await reopened.root.submit({ type: "input", content: "Continue from handoff" }, context)).wait(context)).status).toBe("done");
  });

  it("manually compacts the model context while preserving all original entries and the summary after reopen", async () => {
    const input = fixture();
    input.faux.setResponses([
      fauxAssistantMessage("First detailed answer ".repeat(10)),
      fauxAssistantMessage("Second detailed answer ".repeat(10)),
      fauxAssistantMessage("Newest answer stays verbatim"),
      fauxAssistantMessage("Audit summary remembers the original task"),
    ]);
    const first = await open(input);
    for (const content of ["First old question", "Second old question", "Newest question"]) {
      expect((await (await first.root.submit({ type: "input", content }, context)).wait(context)).status).toBe("done");
    }
    const before = await history(first.root);
    const taskId = await first.root.compact("Keep the original task", context);
    const { outcome } = (await first.harness.waitForTask(taskId, context)).state;
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed" || !outcome.result.submissionId) throw new Error("Compaction did not submit a summary");
    const summarySubmission = await first.harness.submission(outcome.result.submissionId, context);
    expect((await summarySubmission!.wait(context)).status).toBe("done");
    const compacted = await first.root.context(context);
    expect(compacted.head?.kind).toBe("pi.compaction");
    expect(text(compacted.messages)).toContain("Audit summary remembers the original task");
    expect(text(compacted.messages)).toContain("Newest answer stays verbatim");
    expect(text(compacted.messages)).not.toContain("First old question");
    expect((await history(first.root)).map(entry => entry.id)).toEqual(expect.arrayContaining(before.map(entry => entry.id)));
    expect(input.faux.state.callCount).toBe(4);
    await close(first.harness);
    const reopened = await open(input);
    expect((await reopened.root.context(context)).head?.id).toBe(compacted.head?.id);
    expect((await history(reopened.root)).map(entry => entry.id)).toEqual(expect.arrayContaining(before.map(entry => entry.id)));
  });

  it("persists queued follow-ups and withdrawal receipts across close, then resumes each accepted input once", async () => {
    const input = fixture();
    input.faux.setResponses([(_transcript, options) => new Promise(resolve => {
      options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true });
    })]);
    const first = await open(input);
    const initial = await first.root.submit({ type: "input", content: "Original accepted input", requestId: "original" }, context);
    await vi.waitFor(() => expect(input.faux.state.callCount).toBe(1));
    const queued = await first.root.submit({ type: "input", content: "Accepted follow-up", requestId: "follow" }, context);
    const withdrawn = await first.root.submit({ type: "input", content: "Withdrawn follow-up", requestId: "withdrawn" }, context);
    expect(await withdrawn.abort(context)).toBe("aborted");
    await close(first.harness);
    input.faux.setResponses([fauxAssistantMessage("Resumed original answer"), fauxAssistantMessage("Follow-up answer")]);
    const reopened = await open(input);
    const retried = await reopened.root.submit({ type: "input", content: "Original accepted input", requestId: "original" }, context);
    expect(retried.id).toBe(initial.id);
    expect((await retried.wait(context)).status).toBe("done");
    expect((await (await reopened.harness.submission(queued.id, context))!.wait(context)).status).toBe("done");
    expect(await (await reopened.harness.submission(withdrawn.id, context))!.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
    const restoredUsers = (await history(reopened.root)).flatMap(entry => entry.model ?? []).filter(message => message.role === "user");
    expect(restoredUsers.map(message => text([message]))).toEqual(["Original accepted input", "Accepted follow-up"]);
    expect(input.faux.state.callCount).toBe(3);
  });
});
