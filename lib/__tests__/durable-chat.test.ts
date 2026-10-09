import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai-durable";
import type { HarnessOptions } from "@earendil-works/pi-durable";
import { createDurableChat, openDurableChat, type DurableChat, type DurableChatOptions } from "../durable-chat";
import { durableContext } from "../durable-session-store";

const roots: string[] = [];
const chats: DurableChat[] = [];
function fixture(): { options: DurableChatOptions; faux: ReturnType<typeof fauxProvider> } {
  const directory = mkdtempSync(join(tmpdir(), "pi-web-durable-chat-")); roots.push(directory);
  const faux = fauxProvider({ provider: "chat-integration", models: [{ id: "first" }, { id: "second" }], tokensPerSecond: 0 });
  const models = createModels(); models.setProvider(faux.provider);
  return { faux, options: { cwd: directory, directory, provider: "chat-integration", modelId: "first", models: models as unknown as HarnessOptions["models"], settings: { compaction: { enabled: false }, retry: { enabled: false } } } };
}
async function open(options: DurableChatOptions) { const chat = await createDurableChat(options); chats.push(chat); return chat; }
afterEach(async () => { for (const chat of chats.splice(0)) await chat.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Durable chat host", () => {
  it("uses one persisted receipt for repeated prompts and projects a reconnect snapshot", async () => {
    const { options, faux } = fixture(); faux.setResponses([fauxAssistantMessage("One saved answer")]);
    const chat = await open(options);
    const command = { type: "prompt", message: "One question", requestId: "lost-ack", awaitCompletion: true };
    await chat.send(command); await chat.send(command);
    expect(faux.state.callCount).toBe(1);
    expect(chat.getSessionData().context.messages.filter(message => message.role === "user")).toHaveLength(1);
    const records: Record<string, unknown>[] = [];
    const stop = chat.onStreamEvent(record => records.push(JSON.parse(record.data)), "old:1"); stop();
    const snapshot = records.find(record => record.type === "session_snapshot");
    expect(snapshot).toMatchObject({ replayStatus: "reset", state: { isStreaming: false }, sessionData: { sessionId: chat.sessionId } });
    await chat.rename("Persistent name");
    const group = chat.sessionId.split("_")[1]; await chat.close();
    const restored = await open({ ...options, group });
    expect(restored.getSessionData().info.name).toBe("Persistent name");
    await restored.send(command);
    expect(faux.state.callCount).toBe(1);
  });
  it("forks before a chosen message without changing the source and changes the child model", async () => {
    const { options, faux } = fixture(); faux.setResponses([fauxAssistantMessage("Original answer"), fauxAssistantMessage("Branch answer")]);
    const chat = await open(options); await chat.send({ type: "prompt", message: "Original question", requestId: "first", awaitCompletion: true });
    const source = chat.getSessionData();
    const fork = await chat.fork(source.context.entryIds!.at(-1), true);
    await fork.send({ type: "set_model", provider: "chat-integration", modelId: "second" });
    await fork.send({ type: "prompt", message: "Alternate", requestId: "branch", awaitCompletion: true });
    expect(fork.getState().model?.id).toBe("second");
    expect(fork.getSessionData().context.messages.some(message => JSON.stringify(message).includes("Original answer"))).toBe(false);
    expect(chat.getSessionData()).toEqual(source);
    expect(fork.getSessionData().info.parentSessionId).toBe(chat.sessionId);
  });
  it("restores a pending question and accepts the answer once after reopening", async () => {
    const { options, faux } = fixture(); faux.setResponses([
      fauxAssistantMessage(fauxToolCall("ask_user", { questions: [{ id: "target", question: "Target?", options: [{ label: "Staging" }] }] }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Answer received"),
    ]);
    const chat = await open(options); await chat.send({ type: "prompt", message: "Ask", requestId: "ask" });
    const events: Record<string, unknown>[] = []; const stop = chat.onEvent(event => events.push(event));
    await vi.waitFor(() => expect(events.some(event => event.method === "ask_user")).toBe(true)); stop();
    const pending = events.find(event => event.method === "ask_user")!;
    const group = chat.sessionId.split("_")[1]; await chat.close();
    const restored = await open({ ...options, group });
    expect(faux.state.callCount).toBe(1);
    const answer = { type: "extension_ui_response", id: pending.id, answers: { target: "Staging" } };
    expect(await restored.send(answer)).toMatchObject({ accepted: true });
    await restored.resume();
    await restored.send({ type: "prompt", message: "Ask", requestId: "ask", awaitCompletion: true });
    expect(await restored.send(answer)).toMatchObject({ accepted: true });
    expect(faux.state.callCount).toBe(2);
    expect(restored.getSessionData().context.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "Answer received" }] });
  });
  it("reset preserves readable history while clearing model context; temporary mode writes no store", async () => {
    const { options, faux } = fixture(); faux.setResponses([fauxAssistantMessage("Old answer")]);
    const chat = await open({ ...options, ephemeral: true });
    await chat.send({ type: "prompt", message: "Old question", awaitCompletion: true });
    const projection = chat.getProjection();
    await chat.send({ type: "reset" });
    expect(chat.getSessionData().context.messages).toHaveLength(0);
    expect(durableContext(chat.getProjection().entries, projection.agent, projection.context.entryIds!.at(-1)).messages).toHaveLength(2);
    expect(chat.getSessionData().tree.length).toBeGreaterThan(0);
    expect(readdirSync(options.directory!)).toEqual([]);
  });
  it("reports a no-op compaction with a stable receipt rather than an endless progress banner", async () => {
    const { options, faux } = fixture(); const chat = await open(options);
    const result = await chat.send({ type: "compact", requestId: "compact-once" });
    expect(result).toMatchObject({ id: "compact-once", status: "skipped", notice: "nothing_to_compact" });
    await chat.send({ type: "compact", requestId: "compact-once" });
    expect(faux.state.callCount).toBe(0);
    expect(chat.getState()).toMatchObject({ isCompacting: false, compaction: result });
    await expect(chat.send({ type: "compact", requestId: "compact-once", customInstructions: "different" })).rejects.toThrow("conflicts");
  });
  it("closes questions on explicit stop and never resumes their cancelled run", async () => {
    const { options, faux } = fixture(); faux.setResponses([
      fauxAssistantMessage(fauxToolCall("ask_user", { questions: [{ id: "target", question: "Target?", options: [{ label: "Staging" }] }] }), { stopReason: "toolUse" }),
    ]);
    const chat = await open(options); const events: Record<string, unknown>[] = [];
    chat.onEvent(event => events.push(event));
    const command = { type: "prompt", message: "Ask", requestId: "stop-ask" };
    await chat.send(command);
    await vi.waitFor(() => expect(events.some(event => event.method === "ask_user")).toBe(true));
    const pending = events.find(event => event.method === "ask_user")!;
    await chat.send({ type: "abort" });
    const group = chat.sessionId.split("_")[1]; await chat.close();
    const restored = await open({ ...options, group });
    await restored.resume();
    await expect(restored.send({ ...command, awaitCompletion: true })).rejects.toThrow("did not complete");
    expect(await restored.send({ type: "extension_ui_response", id: pending.id, answers: { target: "Staging" } })).toMatchObject({ accepted: false });
    expect(faux.state.callCount).toBe(1);
  });
  it("reparents forks when the original conversation is deleted without erasing their history", async () => {
    const { options, faux } = fixture(); faux.setResponses([fauxAssistantMessage("Keep this answer")]);
    const chat = await open(options); await chat.send({ type: "prompt", message: "Original", awaitCompletion: true });
    const fork = await chat.fork();
    await chat.remove();
    expect(chat.isAlive()).toBe(false);
    expect(fork.getSessionData().info.parentSessionId).toBeUndefined();
    expect(fork.getSessionData().context.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "Keep this answer" }] });
    await fork.close();
    const reopened = await openDurableChat(fork.sessionId, options); chats.push(reopened);
    expect(reopened.getSessionData().info.parentSessionId).toBeUndefined();
    expect(reopened.getSessionData().context.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "Keep this answer" }] });
  });
  it("preserves edited follow-ups while a question is pending across reopening", async () => {
    const { options, faux } = fixture();
    faux.setResponses([fauxAssistantMessage(fauxToolCall("ask_user", { questions: [{ id: "target", question: "Target?" }] }), { stopReason: "toolUse" })]);
    const chat = await open(options); const events: Record<string, unknown>[] = []; chat.onEvent(event => events.push(event));
    await chat.send({ type: "prompt", message: "Ask", requestId: "queue-start" });
    await vi.waitFor(() => expect(events.some(event => event.method === "ask_user")).toBe(true));
    await chat.send({ type: "follow_up", message: "First", requestId: "queued-first" });
    await chat.send({ type: "follow_up", message: "Second", requestId: "queued-second" });
    await vi.waitFor(() => expect(chat.getState().queuedFollowUps).toHaveLength(2));
    const queue = chat.getState().queuedFollowUps!;
    await chat.send({ type: "replace_queue", items: [{ ...queue[1], message: "Edited second" }] });
    const group = chat.sessionId.split("_")[1]; await chat.close();
    const restored = await open({ ...options, group });
    expect(restored.getState().queuedFollowUps).toMatchObject([{ id: queue[1].id, message: "Edited second" }]);
    await expect(restored.send({ type: "replace_queue", items: queue })).rejects.toThrow("already delivered");
    expect(faux.state.callCount).toBe(1);
  });
  it("projects native child tasks as readable dashboard runs with their Web identity", async () => {
    const { options, faux } = fixture();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("subagent", { agent: "scout", task: "Inspect fixture", agentScope: "builtin" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Child result"), fauxAssistantMessage("Parent complete"),
    ]);
    const chat = await open(options);
    await chat.send({ type: "prompt", message: "Delegate", awaitCompletion: true });
    const children = readdirSync(options.directory!).filter(file => /^[1-9][0-9]*\.json$/.test(file) && file !== "1.json").map(file => JSON.parse(readFileSync(join(options.directory!, file), "utf8")));
    expect(children, JSON.stringify(chat.getSessionData().context.messages)).toHaveLength(1);
    expect(children[0]).toMatchObject({ info: { engine: "durable", parentSessionId: chat.sessionId }, agentRun: { engine: "durable", durableConversation: true, status: "completed", parentRunId: chat.sessionId } });
    expect(children[0].info.created).not.toContain("1970");
    expect(children[0].agentRun.sessionId).toBe(children[0].info.id);
    expect(JSON.stringify(chat.getSessionData().context.messages)).toContain(children[0].info.id);
  });
  it("keeps persisted automatic Goal continuations hidden after reconnecting", async () => {
    const { options, faux } = fixture(); faux.setResponses([fauxAssistantMessage("First step"), fauxAssistantMessage("Second step")]);
    const chat = await open(options);
    await chat.send({ type: "workflow_command", command: "goal", args: "--runs 1 Inspect the fixture" });
    await vi.waitFor(async () => { await chat.send({ type: "get_state" }); expect(faux.state.callCount).toBe(2); expect(chat.getState().isStreaming).toBe(false); });
    expect(chat.getSessionData().context.messages.filter(message => message.role === "user")).toHaveLength(1);
    expect(chat.getSessionData().context.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "custom", customType: "pi-web-goal-continuation", display: false })]));
    const group = chat.sessionId.split("_")[1]; await chat.close();
    const restored = await open({ ...options, group });
    expect(restored.getSessionData().context.messages.filter(message => message.role === "user")).toHaveLength(1);
    expect(faux.state.callCount).toBe(2);
  });
  it("uses the actual provider boundary to enforce a persisted schedule deadline", async () => {
    const { options, faux } = fixture(); faux.setResponses([fauxAssistantMessage("Must not run")]);
    const chat = await open({ ...options, scheduleDeadline: Date.now() - 1 });
    await expect(chat.send({ type: "prompt", message: "Expired schedule", awaitCompletion: true })).rejects.toThrow();
    expect(faux.state.callCount).toBe(0);
  });
});
