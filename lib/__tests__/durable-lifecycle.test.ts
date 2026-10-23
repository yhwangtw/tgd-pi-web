import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { defineTask, type HarnessOptions } from "@earendil-works/pi-durable";
import { createDurableChat, evictIdleDurableHosts, getDurableChat, invalidateDurableSessionsForAuthChange, openDurableChat, type DurableChat, type DurableChatOptions } from "../durable-chat";
import { durableQuestionSnapshot, respondDurableQuestion, waitForDurableHostQuestion } from "../durable-questions";

const context = BACKGROUND_CONTEXT;
const chats: DurableChat[] = [];
const directories: string[] = [];
const expired = () => Date.now() + 16 * 60_000;
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "durable-lifecycle-")); directories.push(directory);
  const faux = fauxProvider({ provider: "lifecycle", models: [{ id: "offline" }], tokensPerSecond: 0 });
  const models = createModels(); models.setProvider(faux.provider);
  const options: DurableChatOptions = { cwd: directory, directory, models: models as unknown as HarnessOptions["models"], provider: "lifecycle", modelId: "offline", settings: { compaction: { enabled: false }, retry: { enabled: false } } };
  const chat = await createDurableChat(options); chats.push(chat);
  return { directory, chat, faux, options };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const chat of chats.splice(0)) await chat.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Durable host lifecycle", () => {
  it("evicts an idle group, releases its lease, and reopens history without scheduling another model call", async () => {
    const { chat, directory, faux, options } = await fixture();
    faux.setResponses([fauxAssistantMessage("Persisted response")]);
    await chat.send({ type: "prompt", message: "Persist me", awaitCompletion: true });
    await chat.harness.waitForIdle(context);
    await vi.waitFor(async () => expect(await evictIdleDurableHosts(expired())).toBe(1));
    expect(chat.isAlive()).toBe(false);
    expect(getDurableChat(chat.sessionId)).toBeUndefined();
    expect(existsSync(`${directory}.lock`)).toBe(false);
    const reopened = await openDurableChat(chat.sessionId, options); chats.push(reopened);
    expect(JSON.stringify(reopened.getSessionData())).toContain("Persisted response");
    expect(faux.state.callCount).toBe(1);
  });

  it("retains a persisted background task even with no cached live run or subscriber", async () => {
    const { chat, faux } = await fixture();
    const parked = defineTask({ name: "lifecycle-parked", version: 1, initial: () => ({ phase: "park" as const }),
      phases: { park: async () => { throw new Error("This pending fixture must never execute"); } },
      abort: async () => { throw new Error("Idle eviction must never abort this task"); },
    });
    const id = await chat.conversation.commit(tx => tx.createTask(parked, {}, { ownership: { kind: "conversation" }, background: true }), context);
    expect(await chat.hasPendingHostState()).toBe(false);
    await expect(chat.reloadExtensions()).rejects.toThrow("Wait for the current response");
    expect(await evictIdleDurableHosts(expired())).toBe(0);
    expect((await chat.harness.getTask(id, context))?.state.status).toBe("pending");
    expect(faux.state.callCount).toBe(0);
  });

  it("retains connected branches, shell commands and persistent host questions", async () => {
    const { chat, faux } = await fixture();
    const child = await chat.fork();
    const stop = child.onStreamEvent(() => {}, null);
    expect(await evictIdleDurableHosts(expired())).toBe(0);
    stop();
    const pending = waitForDurableHostQuestion(chat.harness, chat.conversation, { method: "input", title: "Waiting" }, { requestId: "pending-host-question" });
    await vi.waitFor(async () => expect(await durableQuestionSnapshot(chat.harness, chat.conversation)).toHaveLength(1));
    expect(await evictIdleDurableHosts(expired())).toBe(0);
    await expect(child.reloadExtensions()).rejects.toThrow("Wait for the current response");
    const [question] = await durableQuestionSnapshot(chat.harness, chat.conversation);
    await respondDurableQuestion(chat.harness, chat.conversation, { type: "extension_ui_response", id: question.id, value: "Continue" });
    await pending;
    const shell = chat.send({ type: "bash", command: "sleep 0.2", requestId: "lifecycle-shell" });
    await vi.waitFor(() => expect(chat.retainsHost(false)).toBe(true));
    expect(await evictIdleDurableHosts(expired())).toBe(0);
    await shell;
    await chat.resume();
    await chat.harness.waitForIdle(context);
    expect(faux.state.callCount).toBe(0);
    await vi.waitFor(async () => expect(await evictIdleDurableHosts(expired())).toBe(1));
  });

  it("defers auth/MCP restart through accepted work and restarts after completion without an extra model call", async () => {
    const { chat, faux } = await fixture();
    // Isolated model injection omits credential services. Mark this fixture as
    // credential-owning without opening any production auth/runtime resources.
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    faux.setResponses([async () => { await gate; return fauxAssistantMessage("Finished normally"); }]);
    await chat.send({ type: "prompt", message: "Keep running" });
    await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
    (chat as unknown as { host: { services: object } }).host.services = {};
    expect(await invalidateDurableSessionsForAuthChange()).toEqual({ restarted: 0, deferred: 1 });
    expect(await chat.requestMcpRefresh()).toEqual({ reloaded: false, deferred: true });
    expect(await evictIdleDurableHosts(expired())).toBe(0);
    expect(chat.isAlive()).toBe(true);
    release();
    await vi.waitFor(() => expect(chat.isAlive()).toBe(false));
    expect(faux.state.callCount).toBe(1);
  });

  it("shuts down each extension once and removes deleted chats while keeping surviving branches usable", async () => {
    const { chat, directory, faux } = await fixture();
    const child = await chat.fork();
    const rootShutdown = vi.fn(async () => {}), childShutdown = vi.fn(async () => {});
    (chat as unknown as { extensionHost: object }).extensionHost = { shutdown: rootShutdown };
    (child as unknown as { extensionHost: object }).extensionHost = { shutdown: childShutdown };
    await chat.remove();
    expect(rootShutdown).toHaveBeenCalledTimes(1);
    expect(getDurableChat(chat.sessionId)).toBeUndefined();
    expect(child.isAlive()).toBe(true);
    await child.rename("Survivor");
    expect(child.getProjection().info.parentSessionId).toBeUndefined();
    await Promise.all([child.close(), child.close()]);
    expect(rootShutdown).toHaveBeenCalledTimes(1);
    expect(childShutdown).toHaveBeenCalledTimes(1);
    expect(existsSync(`${directory}.lock`)).toBe(false);
    expect(faux.state.callCount).toBe(0);
  });
  it("releases the watcher, SQLite host and lease even when extension shutdown fails", async () => {
    const { chat, directory, options } = await fixture();
    const shutdown = vi.fn(async () => { throw new Error("Fixture shutdown failure"); });
    (chat as unknown as { extensionHost: object }).extensionHost = { shutdown };
    await expect(chat.close()).rejects.toThrow("Fixture shutdown failure");
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(getDurableChat(chat.sessionId)).toBeUndefined();
    expect(existsSync(`${directory}.lock`)).toBe(false);
    chats.splice(chats.indexOf(chat), 1);
    const reopened = await openDurableChat(chat.sessionId, options); chats.push(reopened);
    expect(reopened.isAlive()).toBe(true);
  });

  it("finishes extension metadata callbacks before shutdown closes SQLite", async () => {
    const { chat, options } = await fixture();
    const internal = chat as unknown as { extensionHost: object; renameFromExtension(name: string): void };
    internal.extensionHost = { shutdown: async () => { internal.renameFromExtension("Saved on shutdown"); } };
    await chat.close();
    const reopened = await openDurableChat(chat.sessionId, options); chats.push(reopened);
    expect(reopened.getProjection().info.name).toBe("Saved on shutdown");
  });

  it("immediately releases an empty host after a deleted chat's extension shutdown fails", async () => {
    const { chat, directory } = await fixture();
    (chat as unknown as { extensionHost: object }).extensionHost = { shutdown: async () => { throw new Error("Delete shutdown failure"); } };
    await expect(chat.remove()).rejects.toThrow("Delete shutdown failure");
    expect(getDurableChat(chat.sessionId)).toBeUndefined();
    expect(existsSync(`${directory}.lock`)).toBe(false);
    expect(chat.isAlive()).toBe(false);
  });

});
