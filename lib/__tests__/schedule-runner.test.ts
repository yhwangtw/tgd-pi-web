import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSchedule, ScheduleStore } from "../schedule-types";

const harness = vi.hoisted(() => ({
  store: { version: 1, schedules: [], runs: [] } as ScheduleStore,
  startRpcSession: vi.fn(),
}));

vi.mock("../schedule-store", () => ({
  readScheduleStore: vi.fn(() => harness.store),
  mutateScheduleStore: vi.fn((mutate: (store: ScheduleStore) => unknown) => mutate(harness.store)),
  reconcileInterruptedRuns: vi.fn(() => 0),
}));

vi.mock("../rpc-manager", () => ({
  startRpcSession: harness.startRpcSession,
}));

import { ScheduleRunner } from "../schedule-runner";

function schedule(): AgentSchedule {
  return {
    id: "schedule-1",
    name: "Review",
    cwd: "/tmp/project",
    prompt: "Review the project",
    timing: { kind: "daily", time: "09:00" },
    timezone: "UTC",
    enabled: true,
    missedRunPolicy: "run_once",
    toolNames: ["read", "ask_user"],
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
    nextRunAt: "2026-07-24T09:00:00.000Z",
  };
}

beforeEach(() => {
  harness.store = { version: 1, schedules: [schedule()], runs: [] };
  harness.startRpcSession.mockReset();
});

describe("ScheduleRunner", () => {
  it("does not attach or replay persisted active runs on startup", () => {
    harness.store.schedules[0].enabled = false;
    harness.store.runs.push({ id: "interrupted", scheduleId: "schedule-1", scheduleName: "Review", trigger: "manual",
      scheduledFor: "2026-07-24T09:00:00.000Z", startedAt: "2026-07-24T09:00:00.000Z", status: "waiting_for_input", sessionId: "historical-session" });
    const runner = new ScheduleRunner();
    runner.start();
    expect(harness.startRpcSession).not.toHaveBeenCalled();
    runner.dispose();
  });

  it("tracks ask_user as waiting and completes the same normal Pi session", async () => {
    const eventSink: {
      listener?: (event: { type: string; [key: string]: unknown }) => void;
    } = {};
    const session = {
      isAlive: () => true,
      onEvent: vi.fn((next: NonNullable<typeof eventSink.listener>) => {
        eventSink.listener = next;
        return vi.fn();
      }),
      send: vi.fn().mockResolvedValue(null),
    };
    harness.startRpcSession.mockResolvedValue({ session, realSessionId: "session-1" });

    const runner = new ScheduleRunner();
    const reserved = runner.runNow("schedule-1");
    await vi.waitFor(() => expect(harness.store.runs[0].sessionId).toBe("session-1"));
    expect(reserved.status).toBe("running");
    expect(session.send).toHaveBeenCalledWith({
      type: "prompt",
      message: "Review the project",
      awaitCompletion: true,
    });

    eventSink.listener?.({ type: "extension_ui_request", id: "question-1", method: "ask_user", questions: [] });
    expect(harness.store.runs[0].status).toBe("waiting_for_input");

    eventSink.listener?.({ type: "extension_ui_closed", id: "question-1", reason: "answered" });
    expect(harness.store.runs[0].status).toBe("running");

    eventSink.listener?.({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    expect(harness.store.runs[0].status).toBe("completed");
    expect(harness.store.runs[0].finishedAt).toBeDefined();
  });

  it("turns an immediate model/setup rejection into a failed run", async () => {
    const session = {
      isAlive: () => true,
      onEvent: vi.fn(() => vi.fn()),
      send: vi.fn(async (command: { type: string }) => {
        if (command.type === "prompt") throw new Error("No model configured");
        return null;
      }),
    };
    harness.startRpcSession.mockResolvedValue({ session, realSessionId: "session-2" });

    new ScheduleRunner().runNow("schedule-1");
    await vi.waitFor(() => expect(harness.store.runs[0].status).toBe("failed"));
    expect(harness.store.runs[0].error).toBe("No model configured");
  });

  it.each(["length", "stop"])("marks a scheduled %s no-answer result as failed without retrying", async stopReason => {
    let emit!: (event: { type: string; messages: unknown[] }) => void;
    const session = { isAlive: () => true, onEvent: vi.fn(listener => { emit = listener; return vi.fn(); }), send: vi.fn().mockResolvedValue(null) };
    harness.startRpcSession.mockResolvedValue({ session, realSessionId: "limited-schedule" });
    const runner = new ScheduleRunner(); runner.runNow("schedule-1");
    await vi.waitFor(() => expect(harness.store.runs[0].sessionId).toBe("limited-schedule"));
    emit({ type: "agent_end", messages: [{ role: "assistant", stopReason, content: [] }] });
    expect(harness.store.runs[0]).toMatchObject({ status: "failed", error: expect.any(String) });
    expect(session.send.mock.calls.filter(([command]) => command.type === "prompt")).toHaveLength(1);
    runner.dispose();
  });

  it("does not report an aborted background agent as completed", async () => {
    const eventSink: {
      listener?: (event: { type: string; [key: string]: unknown }) => void;
    } = {};
    const session = {
      isAlive: () => true,
      onEvent: vi.fn((next: NonNullable<typeof eventSink.listener>) => {
        eventSink.listener = next;
        return vi.fn();
      }),
      send: vi.fn().mockResolvedValue(null),
    };
    harness.startRpcSession.mockResolvedValue({ session, realSessionId: "session-aborted" });

    new ScheduleRunner().runNow("schedule-1");
    await vi.waitFor(() => expect(harness.store.runs[0].sessionId).toBe("session-aborted"));
    eventSink.listener?.({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "aborted" }],
    });
    expect(harness.store.runs[0]).toMatchObject({
      status: "failed",
      error: "The agent run was aborted",
    });
  });

  it("prevents overlapping manual runs for one schedule", async () => {
    const eventSink: {
      listener?: (event: { type: string; [key: string]: unknown }) => void;
    } = {};
    const session = {
      isAlive: () => true,
      onEvent: vi.fn((next: NonNullable<typeof eventSink.listener>) => {
        eventSink.listener = next;
        return vi.fn();
      }),
      send: vi.fn().mockResolvedValue(null),
    };
    harness.startRpcSession.mockResolvedValue({ session, realSessionId: "session-3" });
    const runner = new ScheduleRunner();
    runner.runNow("schedule-1");
    expect(() => runner.runNow("schedule-1")).toThrow(/active run/);
    eventSink.listener?.({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
  });
});
