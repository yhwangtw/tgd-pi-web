import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { AgentEvent, HarnessOptions } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createDurableChat, type DurableChat } from "../durable-chat";

const counts = vi.hoisted(() => ({ entries: 0, contexts: 0, entryInputs: 0, contextInputs: 0, saves: 0, questionReads: 0, workflowReads: 0 }));
vi.mock("../durable-session-store", async importOriginal => {
  const actual = await importOriginal<typeof import("../durable-session-store")>();
  return { ...actual,
    durableEntries: (...args: Parameters<typeof actual.durableEntries>) => { counts.entries++; counts.entryInputs += args[0].length; return actual.durableEntries(...args); },
    durableContext: (...args: Parameters<typeof actual.durableContext>) => { counts.contexts++; counts.contextInputs += args[0].length; return actual.durableContext(...args); },
    saveDurableProjection: (...args: Parameters<typeof actual.saveDurableProjection>) => { counts.saves++; return actual.saveDurableProjection(...args); },
  };
});
vi.mock("../durable-questions", async importOriginal => {
  const actual = await importOriginal<typeof import("../durable-questions")>();
  return { ...actual, durableQuestionSnapshot: (...args: Parameters<typeof actual.durableQuestionSnapshot>) => { counts.questionReads++; return actual.durableQuestionSnapshot(...args); } };
});
vi.mock("../durable-workflow", async importOriginal => {
  const actual = await importOriginal<typeof import("../durable-workflow")>();
  return { ...actual, readDurableWorkflow: (...args: Parameters<typeof actual.readDurableWorkflow>) => { counts.workflowReads++; return actual.readDurableWorkflow(...args); } };
});

type WatchInternals = { watcher: { stop(): Promise<unknown> }; receiveEvents(events: readonly AgentEvent[]): Promise<void>; readLive(): Promise<unknown> };
const roots: string[] = [];
const chats: DurableChat[] = [];
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pi-projection-perf-")); roots.push(directory);
  const faux = fauxProvider({ provider: "projection-fixture", models: [{ id: "model" }], tokensPerSecond: 0 });
  const models = createModels(); models.setProvider(faux.provider);
  const chat = await createDurableChat({ cwd: directory, directory, provider: "projection-fixture", modelId: "model", models: models as unknown as HarnessOptions["models"], settings: { compaction: { enabled: false }, retry: { enabled: false } } });
  chats.push(chat);
  // Deliver exact committed batches below, independently of the asynchronous watcher.
  const internal = chat as unknown as WatchInternals;
  await internal.watcher.stop();
  Object.assign(counts, { entries: 0, contexts: 0, entryInputs: 0, contextInputs: 0, saves: 0, questionReads: 0, workflowReads: 0 });
  return { chat, internal, faux };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const chat of chats.splice(0)) await chat.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Durable projection work", () => {
  it("keeps history and disk bytes unchanged across state reads, while persisting metadata changes", async () => {
    const { chat, faux } = await fixture();
    const original = chat.getProjection();
    for (let i = 0; i < 5; i++) await chat.send({ type: "get_state" });
    expect(counts).toMatchObject({ entries: 0, contexts: 0, saves: 0 });
    expect(chat.getProjection().entries).toBe(original.entries);
    expect(chat.getProjection().context).toBe(original.context);
    await chat.rename("Renamed metadata");
    expect(counts).toMatchObject({ entries: 0, contexts: 0, saves: 1 });
    expect(chat.getProjection().info.name).toBe("Renamed metadata");
    await chat.send({ type: "set_thinking_level", level: "low" });
    expect(chat.getProjection().context.thinkingLevel).toBe("low");
    expect(chat.getProjection().context.messages).toBe(original.context.messages);
    expect(counts).toMatchObject({ entries: 0, contexts: 0, saves: 2 });
    expect(faux.state.callCount).toBe(0);
  });

  it("rebuilds and persists on a committed history change, then reuses the new context", async () => {
    const { chat } = await fixture();
    const previous = chat.getProjection().context;
    await chat.conversation.commit(async tx => { await tx.appendEntry(chat.conversation.id, { kind: "pi.user", model: [{ role: "user", content: "Committed fixture", timestamp: 1 }] }); }, BACKGROUND_CONTEXT);
    await chat.refresh();
    expect(chat.getProjection().context).not.toBe(previous);
    expect(chat.getProjection().context.messages).toMatchObject([{ role: "user", content: "Committed fixture" }]);
    expect(chat.getProjection().info.messageCount).toBe(1);
    expect(counts).toMatchObject({ entries: 1, contexts: 1, saves: 1 });
    await chat.refresh();
    expect(counts).toMatchObject({ entries: 1, contexts: 1, saves: 1 });
  });

  it("converts only new ordinary entries and falls back for compaction and edit records", async () => {
    const { chat } = await fixture();
    const actual = await vi.importActual<typeof import("../durable-session-store")>("../durable-session-store");
    const compare = () => {
      const current = chat.getProjection();
      expect(current.context).toEqual(actual.durableContext(current.entries, current.agent));
      const visible = actual.durableEntries(current.entries, current.info.created).filter(entry => entry.type === "message").filter(entry => ["user", "assistant"].includes(entry.message.role));
      const extract = (message: unknown) => {
        const content = (message as { content?: unknown } | undefined)?.content;
        return typeof content === "string" ? content : Array.isArray(content)
          ? content.filter(block => block.type === "text").map(block => block.text).join("\n") : "";
      };
      const last = visible.at(-1);
      expect(current.info).toMatchObject({ messageCount: visible.length,
        firstMessage: extract(visible.find(entry => entry.message.role === "user")?.message) || "(no messages)",
        lastMessage: extract(last?.message),
        modified: last && "timestamp" in last.message ? new Date(last.message.timestamp ?? Date.parse(current.info.created)).toISOString() : current.info.created });
      expect(current.info.lastMessageId).toBe(last?.id);
    };
    await chat.conversation.commit(async tx => {
      for (let i = 0; i < 40; i++) await tx.appendEntry(chat.conversation.id, { kind: "pi.user", model: [{ role: "user", content: `Fixture ${i}`, timestamp: i + 1 }] });
    }, BACKGROUND_CONTEXT);
    await chat.refresh(); compare();
    await chat.conversation.commit(async tx => { await tx.appendEntry(chat.conversation.id, { kind: "pi.user", model: [{ role: "user", content: "Ordinary append", timestamp: 50 }] }); }, BACKGROUND_CONTEXT);
    await chat.refresh(); compare();
    expect(counts).toMatchObject({ entryInputs: 41, contextInputs: 41 });
    const kept = chat.getProjection().entries[20].id;
    await chat.conversation.commit(async tx => { await tx.appendEntry(chat.conversation.id, { kind: "pi.compaction", head: kept, model: [{ role: "user", content: "Summary", timestamp: 51 }] }); }, BACKGROUND_CONTEXT);
    await chat.refresh(); compare();
    expect(counts).toMatchObject({ entryInputs: 83, contextInputs: 83 });
    await chat.conversation.commit(async tx => { await tx.appendEntry(chat.conversation.id, { kind: "pi.user", model: [{ role: "user", content: "After compaction", timestamp: 52 }] }); }, BACKGROUND_CONTEXT);
    await chat.refresh(); compare();
    expect(counts).toMatchObject({ entryInputs: 84, contextInputs: 84 });
    await chat.conversation.commit(async tx => { await tx.appendEntry(chat.conversation.id, { kind: "fixture.edit", edits: [{ action: "replace", target: kept, messages: [{ role: "user", content: "Edited older entry", timestamp: 21 }] }] }); }, BACKGROUND_CONTEXT);
    await chat.refresh(); compare();
    expect(counts).toMatchObject({ entryInputs: 128, contextInputs: 128 });
    await chat.conversation.commit(async tx => { await tx.appendEntry(chat.conversation.id, { kind: "pi.user", model: [{ role: "user", content: "After edit", timestamp: 53 }] }); }, BACKGROUND_CONTEXT);
    await chat.refresh(); compare();
    expect(counts).toMatchObject({ entryInputs: 173, contextInputs: 173 });
  });

  it("matches full context for appended multi-message, custom and shell entries", async () => {
    const { chat } = await fixture();
    const actual = await vi.importActual<typeof import("../durable-session-store")>("../durable-session-store");
    await chat.conversation.commit(async tx => {
      await tx.appendEntry(chat.conversation.id, { kind: "pi.user", model: [{ role: "user", content: "First message", timestamp: 1 }] });
    }, BACKGROUND_CONTEXT);
    await chat.refresh();
    await chat.conversation.commit(async tx => {
      await tx.appendEntry(chat.conversation.id, { kind: "fixture.multi", model: [
        { role: "system", content: "Not in context", timestamp: 0 },
        { role: "user", content: "Second message", timestamp: 2 },
        fauxAssistantMessage("Assistant response"),
      ] });
      await tx.appendEntry(chat.conversation.id, { kind: "pi-web.extension-message", data: { customType: "fixture", content: "Custom context", display: false, details: null } });
      await tx.appendEntry(chat.conversation.id, { kind: "pi-web.shell", data: { command: "fixture command", output: "fixture output", timestamp: 3 } });
      await tx.appendEntry(chat.conversation.id, { kind: "fixture.empty" });
    }, BACKGROUND_CONTEXT);
    await chat.refresh();
    const current = chat.getProjection();
    expect(current.context).toEqual(actual.durableContext(current.entries, current.agent));
    expect(current.context.messages.map(message => message.role)).toEqual(["user", "user", "assistant", "custom", "bashExecution"]);
    expect(current.info).toMatchObject({ messageCount: 3, firstMessage: "First message", lastMessage: "Assistant response" });
    expect(current.info.lastMessageId).toBe(`${current.entries[1].id}:2`);
    expect(counts).toMatchObject({ entryInputs: 5, contextInputs: 5, saves: 2 });
  });

  it("forwards token batches without rereading UI documents or rebuilding saved history", async () => {
    const { chat, internal } = await fixture();
    const events: Record<string, unknown>[] = [];
    const stop = chat.onEvent(event => events.push(event));
    const live = vi.spyOn(internal, "readLive");
    for (let i = 0; i < 3; i++) {
      const message = fauxAssistantMessage(`Partial ${i}`);
      live.mockResolvedValueOnce({ generation: { attempt: 1, message } });
      await internal.receiveEvents([{ type: "message_update", usage: message.usage, changes: [] }]);
    }
    expect(live).toHaveBeenCalledTimes(3);
    expect(events.filter(event => event.type === "message_update")).toHaveLength(3);
    expect(counts).toMatchObject({ entries: 0, contexts: 0, entryInputs: 0, contextInputs: 0, saves: 0, questionReads: 0, workflowReads: 0 });
    // Non-token commits still reconcile persisted questions and workflow state.
    await internal.receiveEvents([{ type: "turn_start" }]);
    expect(counts).toMatchObject({ questionReads: 1, workflowReads: 1 });
    stop();
  });
});
