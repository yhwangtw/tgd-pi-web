import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSchedule, ScheduleRun, ScheduleStore } from "../schedule-types";

const fixture = vi.hoisted(() => ({
  directory: "", store: { version: 1, schedules: [], runs: [] } as ScheduleStore,
  startRpcSession: vi.fn(), createDurableChat: vi.fn(), getDurableChat: vi.fn(), openDurableChat: vi.fn(),
}));
vi.mock("../rpc-manager", () => ({ startRpcSession: fixture.startRpcSession }));
vi.mock("../durable-chat", () => ({ createDurableChat: fixture.createDurableChat, getDurableChat: fixture.getDurableChat, openDurableChat: fixture.openDurableChat }));
vi.mock("../durable-session-store", () => ({ durableSessionDirectory: () => fixture.directory, durableSessionId: (group: string, conversation: number) => `dw_${group}_${conversation}` }));
vi.mock("../schedule-store", () => ({
  readScheduleStore: () => fixture.store,
  mutateScheduleStore: (mutate: (store: ScheduleStore) => unknown) => mutate(fixture.store),
  reconcileInterruptedRuns: vi.fn(),
}));
vi.mock("../web-push", () => ({ sendWebPush: vi.fn() }));
import { ScheduleRunner } from "../schedule-runner";

const runners: ScheduleRunner[] = [];
function runner() { const value = new ScheduleRunner(); runners.push(value); return value; }
function schedule(): AgentSchedule {
  return { id: "schedule-1", name: "Review", engine: "durable", cwd: "/tmp/project", prompt: "Original review",
    timing: { kind: "daily", time: "09:00" }, timezone: "UTC", enabled: false, missedRunPolicy: "run_once",
    provider: "fixture", modelId: "reviewer", thinkingLevel: "high", toolNames: ["read", "ask_user"],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), nextRunAt: null };
}
function activeRun(): ScheduleRun {
  const config = schedule();
  const id = "12345678-1234-4234-9234-123456789abc";
  return { id, scheduleId: config.id, scheduleName: config.name, trigger: "manual", engine: "durable",
    startedAt: new Date().toISOString(), scheduledFor: new Date().toISOString(), status: "running", sessionId: `dw_${id}_1`,
    execution: { cwd: config.cwd, prompt: config.prompt, provider: config.provider, modelId: config.modelId,
      thinkingLevel: config.thinkingLevel, toolNames: [...config.toolNames] } };
}
function chat() {
  let listener: ((event: Record<string, unknown>) => void) | undefined;
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  let alive = true;
  const pending = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  const session = {
    isAlive: () => alive,
    onEvent: vi.fn((callback: (event: Record<string, unknown>) => void) => { listener = callback; return () => { listener = undefined; }; }),
    send: vi.fn(async (command: { type: string }) => command.type === "prompt" ? pending : null),
  };
  return { session, resolve, reject, emit: (event: Record<string, unknown>) => listener?.(event),
    close: () => { alive = false; listener?.({ type: "session_restart" }); reject(new Error("Storage closed")); } };
}

beforeEach(() => {
  fixture.directory = mkdtempSync(join(tmpdir(), "pi-durable-schedule-"));
  fixture.store = { version: 1, schedules: [schedule()], runs: [] };
  for (const mock of [fixture.startRpcSession, fixture.createDurableChat, fixture.getDurableChat, fixture.openDurableChat]) mock.mockReset();
});
afterEach(() => {
  for (const value of runners.splice(0)) value.dispose();
  rmSync(fixture.directory, { recursive: true, force: true });
});

describe("durable schedules", () => {
  it("reserves a stable session and original settings before creating the native host, then waits for committed settlement", async () => {
    const value = chat();
    fixture.createDurableChat.mockImplementation(async () => {
      expect(fixture.store.runs[0]).toMatchObject({ engine: "durable", status: "running", execution: { prompt: "Original review" } });
      expect(fixture.store.runs[0].sessionId).toBe(`dw_${fixture.store.runs[0].id}_1`);
      return value.session;
    });
    const reserved = runner().runNow("schedule-1");
    fixture.store.schedules[0].prompt = "Changed later";
    await vi.waitFor(() => expect(value.session.send).toHaveBeenCalledWith({ type: "prompt", message: "Original review", requestId: `schedule:${reserved.id}`, awaitCompletion: true }));
    expect(fixture.createDurableChat).toHaveBeenCalledWith(expect.objectContaining({ group: reserved.id, cwd: "/tmp/project", provider: "fixture", modelId: "reviewer", thinkingLevel: "high", toolNames: ["read", "ask_user"] }));
    expect(fixture.startRpcSession).not.toHaveBeenCalled();
    value.emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
    expect(fixture.store.runs[0].status).toBe("running");
    value.resolve();
    await vi.waitFor(() => expect(fixture.store.runs[0].status).toBe("completed"));
  });

  it("recovers the same receipt and frozen prompt even after the schedule is edited", async () => {
    const reserved = activeRun();
    reserved.status = "waiting_for_input";
    fixture.store.runs = [reserved];
    fixture.store.schedules[0].prompt = "Different edited task";
    fixture.store.schedules[0].cwd = "/another/workspace";
    writeFileSync(join(fixture.directory, "bootstrap.json"), "{}");
    const value = chat();
    const attach = value.session.onEvent.getMockImplementation()!;
    value.session.onEvent.mockImplementation(callback => {
      const unsubscribe = attach(callback);
      callback({ type: "extension_ui_request", id: "q1", method: "ask_user", questions: [] });
      return unsubscribe;
    });
    fixture.openDurableChat.mockResolvedValue(value.session);
    const scheduler = runner();
    scheduler.start(); scheduler.start();
    await vi.waitFor(() => expect(value.session.send).toHaveBeenCalledWith({ type: "prompt", message: "Original review", requestId: `schedule:${reserved.id}`, awaitCompletion: true }));
    expect(fixture.openDurableChat).toHaveBeenCalledExactlyOnceWith(reserved.sessionId);
    expect(fixture.createDurableChat).not.toHaveBeenCalled();
    expect(fixture.store.runs).toHaveLength(1);
    expect(fixture.store.runs[0].status).toBe("waiting_for_input");
    value.emit({ type: "extension_ui_closed", id: "q1", reason: "answered" });
    expect(fixture.store.runs[0].status).toBe("running");
    value.resolve();
    await vi.waitFor(() => expect(fixture.store.runs[0].status).toBe("completed"));
  });

  it("recreates only the reserved store when interrupted before native initialization", async () => {
    const reserved = activeRun();
    fixture.store.runs = [reserved];
    fixture.store.schedules = []; // Recovery does not depend on mutable schedule configuration.
    const value = chat(); fixture.createDurableChat.mockResolvedValue(value.session);
    runner().start();
    await vi.waitFor(() => expect(value.session.send).toHaveBeenCalled());
    expect(fixture.createDurableChat).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ group: reserved.id, prompt: "Original review" }));
    expect(fixture.openDurableChat).not.toHaveBeenCalled();
    value.resolve();
    await vi.waitFor(() => expect(fixture.store.runs[0].status).toBe("completed"));
  });

  it("leaves an interrupted host recoverable and ignores the old detached completion", async () => {
    const first = chat(); fixture.createDurableChat.mockResolvedValue(first.session);
    runner().runNow("schedule-1");
    await vi.waitFor(() => expect(first.session.send).toHaveBeenCalled());
    first.close();
    await Promise.resolve();
    expect(fixture.store.runs[0].status).toBe("running");
    expect(fixture.store.runs[0].finishedAt).toBeUndefined();
    const resumed = chat(); fixture.getDurableChat.mockReturnValue(resumed.session);
    runner().start();
    await vi.waitFor(() => expect(resumed.session.send).toHaveBeenCalled());
    expect(fixture.createDurableChat).toHaveBeenCalledTimes(1);
    resumed.resolve();
    await vi.waitFor(() => expect(fixture.store.runs[0].status).toBe("completed"));
  });

  it("does not declare success after agent_end if the native receipt fails", async () => {
    const value = chat(); fixture.createDurableChat.mockResolvedValue(value.session);
    runner().runNow("schedule-1");
    await vi.waitFor(() => expect(value.session.send).toHaveBeenCalled());
    value.emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
    value.reject(new Error("Response did not complete: cancelled"));
    await vi.waitFor(() => expect(fixture.store.runs[0]).toMatchObject({ status: "failed", error: "Response did not complete: cancelled" }));
  });

  it("retains the original deadline on recovery and cancels expired work without submitting again", async () => {
    const reserved = activeRun();
    reserved.startedAt = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    fixture.store.runs = [reserved];
    const value = chat(); fixture.getDurableChat.mockReturnValue(value.session);
    runner().start();
    await vi.waitFor(() => expect(fixture.store.runs[0]).toMatchObject({ status: "failed", error: "Scheduled run exceeded the 24-hour limit" }));
    expect(value.session.send).toHaveBeenCalledExactlyOnceWith({ type: "abort" });
    expect(fixture.createDurableChat).not.toHaveBeenCalled();
  });

  it("does not attach legacy or already settled runs during startup", () => {
    fixture.store.runs = [{ ...activeRun(), engine: undefined }, { ...activeRun(), status: "completed" }];
    runner().start();
    expect(fixture.createDurableChat).not.toHaveBeenCalled();
    expect(fixture.openDurableChat).not.toHaveBeenCalled();
    expect(fixture.getDurableChat).not.toHaveBeenCalled();
  });

  it("fails an invalid recovery record without inventing a new conversation", async () => {
    fixture.store.runs = [{ ...activeRun(), execution: undefined }];
    runner().start();
    await vi.waitFor(() => expect(fixture.store.runs[0].status).toBe("failed"));
    expect(fixture.store.runs[0].error).toContain("original execution settings");
    expect(fixture.createDurableChat).not.toHaveBeenCalled();
  });
});
