import { describe, expect, it, vi } from "vitest";
import type { AgentRunState } from "../agent-run-state";
import type { AgentSessionLike } from "../pi-types";
import { AgentSessionWrapper, type AgentEvent } from "../rpc-manager";
import { createRunTimingExtension } from "../pi-runtime";

const harness = vi.hoisted(() => ({ snapshot: vi.fn(async () => {}) }));
vi.mock("../git-snapshot", () => ({ createSnapshot: harness.snapshot }));
const TIMING = "88deba82-f371-4f25-bd5d-cab39107d41f";
function fixture() {
  let listener: (event: AgentEvent) => void = () => {};
  const inner = { sessionId: "timing-fixture", sessionFile: "", isStreaming: false, dispose: vi.fn(),
    sessionManager: { getEntries: () => [], getBranch: () => [], getLeafId: () => null },
    subscribe: (callback: typeof listener) => { listener = callback; return () => {}; },
    prompt: vi.fn(async () => {}), abort: vi.fn(async () => {}),
  };
  const wrapper = new AgentSessionWrapper(inner as unknown as AgentSessionLike, "/fixture");
  wrapper.start();
  const events: AgentEvent[] = []; wrapper.onEvent(event => events.push({ ...event }));
  return { inner, wrapper, events, emit: (event: AgentEvent) => listener(event) };
}

describe("runtime latency boundaries", () => {
  it("observes the documented Standard extension hook without reading or replacing model payload", async () => {
    let callback!: (event: unknown) => unknown;
    const observe = vi.fn();
    const extension = createRunTimingExtension(observe);
    const pi = { on: vi.fn((name: string, handler: typeof callback) => { expect(name).toBe("before_provider_request"); callback = handler; }) };
    if (typeof extension === "function") await extension(pi as never); else await extension.factory(pi as never);
    const event = { get payload() { throw new Error("must not inspect credentials/prompt"); } };
    expect(callback(event)).toBeUndefined(); expect(observe).toHaveBeenCalledOnce();
    observe.mockImplementation(() => { throw new Error("diagnostic failed"); });
    expect(() => callback(event)).not.toThrow();
  });

  it("tracks SDK work independently from extension UI events", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-29T00:00:00Z"));
    const { wrapper, emit } = fixture();
    try {
      emit({ type: "agent_start" });
      const progressAt = () => (wrapper.getStreamSnapshot().state as { runState: AgentRunState }).runState.lastProgressAt;
      const started = progressAt();
      vi.advanceTimersByTime(10_000);
      emit({ type: "extension_ui_request", method: "set_status" });
      expect(progressAt()).toBe(started);
      emit({ type: "tool_execution_update", toolCallId: "read-1" });
      expect(progressAt()).toBe(Date.now());
    } finally { wrapper.destroy(); vi.useRealTimers(); }
  });

  it("retains per-tool starts and upstream child states in snapshots", () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000);
    const { wrapper, emit, events } = fixture();
    try {
      emit({ type: "agent_start" });
      emit({ type: "tool_execution_start", toolCallId: "a", toolName: "read" });
      vi.advanceTimersByTime(5_000);
      emit({ type: "tool_execution_start", toolCallId: "b", toolName: "subagent" });
      emit({ type: "tool_execution_update", toolCallId: "b", partialResult: { details: { progress: [{ index: 0, agent: "scout", status: "running" }] } } });
      const phase = (wrapper.getStreamSnapshot().state as { runState: AgentRunState }).runState.phase;
      expect(phase).toMatchObject({ kind: "running_tools", tools: [
        { id: "a", startedAt: 100_000 }, { id: "b", startedAt: 105_000, children: [{ id: "0", label: "scout", state: "running" }] },
      ] });
      expect(events.findLast(event => event.type === "tool_execution_update")?.toolActivity).toMatchObject({ id: "b", startedAt: 105_000 });
      emit({ type: "tool_execution_end", toolCallId: "a" });
      expect((wrapper.getStreamSnapshot().state as { runState: AgentRunState }).runState.phase).toMatchObject({ tools: [{ id: "b" }] });
    } finally { wrapper.destroy(); vi.useRealTimers(); }
  });

  it("accepts before snapshot and forwards only observed stages without adding timingId to SDK inputs or replay", async () => {
    const { inner, wrapper, events, emit } = fixture();
    const order: string[] = [];
    harness.snapshot.mockImplementation(async () => { order.push("snapshot"); });
    wrapper.onEvent(event => { if (event.type === "run_timing") order.push(String(event.stage)); });
    inner.prompt.mockImplementation(async () => {
      inner.isStreaming = true; emit({ type: "agent_start" }); wrapper.markProviderRequest();
      emit({ type: "message_start", message: { role: "assistant", content: [] } });
      emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "private answer" }] } });
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "private answer" }] } });
      inner.isStreaming = false; emit({ type: "agent_end", messages: [] });
    });
    const stream: Array<{ id?: string; data: string }> = [];
    const stop = wrapper.onStreamEvent(record => stream.push(record), null);
    const initialCursor = stream[0].id!;
    try {
      await wrapper.send({ type: "prompt", message: "private question", timingId: TIMING, awaitCompletion: true });
      expect(order).toEqual(["accepted", "snapshot", "provider_request", "first_content", "completed"]);
      expect(inner.prompt).toHaveBeenCalledWith("private question", undefined);
      const timings = events.filter(event => event.type === "run_timing");
      expect(timings).toHaveLength(4);
      expect(timings.every(event => Object.keys(event).sort().join() === "elapsedMs,stage,timingId,type")).toBe(true);
      expect(stream.filter(record => JSON.parse(record.data).type === "run_timing").every(record => !record.id)).toBe(true);
      const replay: string[] = [];
      const stopReplay = wrapper.onStreamEvent(record => replay.push(record.data), initialCursor); stopReplay();
      expect(replay.some(data => JSON.parse(data).type === "run_timing")).toBe(false);
    } finally { stop(); wrapper.destroy(); }
  });

  it.each([undefined, "invalid"])("does not emit latency for untraced commands (%j)", async timingId => {
    const { wrapper, events } = fixture();
    try { await wrapper.send({ type: "prompt", message: "background", timingId, awaitCompletion: true }); wrapper.markProviderRequest(); expect(events.some(event => event.type === "run_timing")).toBe(false); }
    finally { wrapper.destroy(); }
  });

  it("closes setup failures and clears active observations on abort/shutdown", async () => {
    const { inner, wrapper, events } = fixture();
    try {
      inner.prompt.mockRejectedValueOnce(new Error("No model configured"));
      await expect(wrapper.send({ type: "prompt", message: "fixture", timingId: TIMING, awaitCompletion: true })).rejects.toThrow("No model configured");
      expect(events.filter(event => event.type === "run_timing").map(event => event.stage)).toEqual(["accepted", "completed"]);
      events.length = 0;
      let resolve!: () => void;
      inner.prompt.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
      await wrapper.send({ type: "prompt", message: "fixture", timingId: TIMING });
      await wrapper.send({ type: "abort" }); wrapper.markProviderRequest(); resolve(); await Promise.resolve();
      expect(events.filter(event => event.type === "run_timing").map(event => event.stage)).toEqual(["accepted"]);
      wrapper.destroy(); wrapper.markProviderRequest();
      expect(events.filter(event => event.type === "run_timing").map(event => event.stage)).toEqual(["accepted"]);
    } finally { wrapper.destroy(); }
  });
});
