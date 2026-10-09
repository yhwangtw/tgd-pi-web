import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai-durable";
import type { HarnessOptions } from "@earendil-works/pi-durable";
import type { DurableChat, DurableChatOptions } from "../durable-chat";
import type { ScheduleStore } from "../schedule-types";

const fixture = vi.hoisted(() => ({
  directory: "", models: undefined as HarnessOptions["models"] | undefined,
  store: { version: 1, schedules: [], runs: [] } as ScheduleStore,
  chats: [] as DurableChat[], starts: 0, reopens: 0,
}));
vi.mock("../rpc-manager", () => ({ startRpcSession: vi.fn(() => { throw new Error("Legacy agent must not run"); }) }));
vi.mock("../schedule-store", () => ({
  readScheduleStore: () => fixture.store,
  mutateScheduleStore: (mutate: (store: ScheduleStore) => unknown) => mutate(fixture.store),
  reconcileInterruptedRuns: vi.fn(),
}));
vi.mock("../durable-session-store", async importOriginal => ({
  ...await importOriginal<typeof import("../durable-session-store")>(),
  durableSessionDirectory: (group: string) => join(fixture.directory, group),
}));
vi.mock("../durable-chat", async importOriginal => {
  const actual = await importOriginal<typeof import("../durable-chat")>();
  const open = async (options: DurableChatOptions) => {
    const chat = await actual.createDurableChat({ ...options, models: fixture.models,
      settings: { compaction: { enabled: false }, retry: { enabled: false } } });
    fixture.chats.push(chat);
    return chat;
  };
  return { ...actual,
    createDurableChat: async (options: DurableChatOptions) => { fixture.starts++; return open(options); },
    // Only model resolution is injected. SQLite, receipts, hooks, tools and session
    // projection use the real native host on the identical persisted group.
    openDurableChat: async (id: string) => {
      fixture.reopens++;
      const run = fixture.store.runs.find(item => item.sessionId === id)!;
      return open({ ...run.execution!, group: run.id, scheduleDeadline: Date.parse(run.startedAt) + 24 * 60 * 60_000 });
    },
  };
});
vi.mock("../web-push", () => ({ sendWebPush: vi.fn() }));
import { ScheduleRunner } from "../schedule-runner";

const runners: ScheduleRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) runner.dispose();
  for (const chat of fixture.chats.splice(0)) await chat.close();
  if (fixture.directory) rmSync(fixture.directory, { recursive: true, force: true });
});

describe("native durable schedule integration", () => {
  it.each(["error", "aborted"] as const)("records an actual provider %s response as failed", async (stopReason) => {
    fixture.directory = mkdtempSync(join(tmpdir(), "pi-schedule-native-failure-"));
    const faux = fauxProvider({ provider: "schedule-native", models: [{ id: "test" }], tokensPerSecond: 0 });
    const models = createModels(); models.setProvider(faux.provider);
    fixture.models = models as unknown as HarnessOptions["models"];
    faux.setResponses([fauxAssistantMessage("", { stopReason, errorMessage: "Provider refused the request" })]);
    const now = new Date().toISOString();
    fixture.store = { version: 1, schedules: [{ id: "schedule-native", name: "Native failure", cwd: fixture.directory,
      engine: "durable", prompt: "Fails", provider: "schedule-native", modelId: "test", toolNames: [],
      timing: { kind: "daily", time: "09:00" }, timezone: "UTC", enabled: false, missedRunPolicy: "run_once",
      createdAt: now, updatedAt: now, nextRunAt: null }], runs: [] };
    const runner = new ScheduleRunner(); runners.push(runner); runner.runNow("schedule-native");
    await vi.waitFor(() => expect(fixture.store.runs[0].status).toBe("failed"));
    expect(fixture.store.runs[0].error).toBeTruthy();
    expect(faux.state.callCount).toBe(1);
  });

  it("resumes the same SQLite conversation and pending question, then returns its actual answer once", async () => {
    fixture.directory = mkdtempSync(join(tmpdir(), "pi-schedule-native-"));
    fixture.starts = 0; fixture.reopens = 0;
    const faux = fauxProvider({ provider: "schedule-native", models: [{ id: "test" }], tokensPerSecond: 0 });
    const models = createModels(); models.setProvider(faux.provider);
    fixture.models = models as unknown as HarnessOptions["models"];
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("ask_user", { questions: [{ id: "target", question: "Choose target", options: [{ label: "Staging" }] }] }), { stopReason: "toolUse" }),
      (transcript) => {
        const answer = transcript.messages.findLast(message => message.role === "toolResult" && message.toolName === "ask_user");
        expect(answer).toBeDefined();
        expect(JSON.stringify(answer)).toContain("Staging");
        return fauxAssistantMessage("Verified scheduled result for Staging");
      },
    ]);
    const now = new Date().toISOString();
    fixture.store = { version: 1, schedules: [{ id: "schedule-native", name: "Native review", cwd: fixture.directory,
      engine: "durable", prompt: "Original scheduled question", provider: "schedule-native", modelId: "test", toolNames: ["ask_user"],
      timing: { kind: "daily", time: "09:00" }, timezone: "UTC", enabled: false, missedRunPolicy: "run_once",
      createdAt: now, updatedAt: now, nextRunAt: null }], runs: [] };
    const first = new ScheduleRunner(); runners.push(first);
    const reserved = first.runNow("schedule-native");
    await vi.waitFor(() => expect(fixture.store.runs[0].status).toBe("waiting_for_input"));
    const original = fixture.chats[0];
    const events: Record<string, unknown>[] = [];
    const stop = original.onEvent(event => events.push(event)); stop();
    const pending = events.find(event => event.method === "ask_user")!;
    expect(pending).toBeDefined();
    expect(faux.state.callCount).toBe(1);
    await original.close(); first.dispose();
    expect(fixture.store.runs[0].status).toBe("waiting_for_input");
    fixture.store.schedules[0].prompt = "Must not replace the original request";
    const second = new ScheduleRunner(); runners.push(second); second.start();
    await vi.waitFor(() => expect(fixture.reopens).toBe(1));
    await vi.waitFor(() => expect(fixture.chats).toHaveLength(2));
    const resumed = fixture.chats[1];
    expect(resumed.sessionId).toBe(reserved.sessionId);
    expect(faux.state.callCount).toBe(1);
    expect(await resumed.send({ type: "extension_ui_response", id: pending.id, answers: { target: "Staging" } })).toMatchObject({ accepted: true });
    await vi.waitFor(() => expect(fixture.store.runs[0].status).toBe("completed"));
    const transcript = resumed.getSessionData().context.messages;
    expect(transcript.filter(message => message.role === "user")).toHaveLength(1);
    expect(JSON.stringify(transcript)).toContain("Original scheduled question");
    expect(JSON.stringify(transcript)).not.toContain("Must not replace the original request");
    expect(transcript.at(-1)).toMatchObject({ content: [{ type: "text", text: "Verified scheduled result for Staging" }] });
    await resumed.send({ type: "prompt", message: "Original scheduled question", requestId: `schedule:${reserved.id}`, awaitCompletion: true });
    expect(faux.state.callCount).toBe(2);
    expect(fixture.starts).toBe(1);
    expect(fixture.store.runs).toHaveLength(1);
  });
});
