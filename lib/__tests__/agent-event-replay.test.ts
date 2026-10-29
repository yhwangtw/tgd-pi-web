import { describe, expect, it, vi } from "vitest";
import { AgentSessionWrapper } from "../rpc-manager";
import type { AgentSessionLike } from "../pi-types";
import type { AgentRunState } from "../agent-run-state";
import { WebExtensionUIBridge } from "../web-extension-ui";

function fixture() {
  let emit!: (event: { type: string; [key: string]: unknown }) => void;
  let streaming = false;
  const inner = {
    sessionId: "replay-fixture", sessionFile: "", model: undefined,
    get isStreaming() { return streaming; }, isCompacting: false,
    agent: { state: {} }, getContextUsage: () => undefined,
    sessionManager: { getEntries: () => [], getLeafId: () => null },
    subscribe: (listener: typeof emit) => { emit = listener; return vi.fn(); }, dispose: vi.fn(),
  } as unknown as AgentSessionLike;
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.start();
  return { wrapper, emit: (event: Parameters<typeof emit>[0]) => { if (event.type === "agent_start") streaming = true; if (event.type === "agent_end") streaming = false; emit(event); } };
}

const runState = (state: unknown) => (state as { runState: AgentRunState | null }).runState;

describe("agent SSE replay contract", () => {
  it("retains one run clock and the actual phase through subscriptions, reads and quiet periods", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const { wrapper, emit } = fixture();
    try {
      emit({ type: "agent_start" });
      const first = runState(await wrapper.send({ type: "get_state" }))!;
      expect(first).toMatchObject({ startedAt: 10_000, lastProgressAt: 10_000, phase: { kind: "waiting_model" } });
      vi.setSystemTime(15_000);
      emit({ type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: "Working" }] } });
      vi.setSystemTime(130_000);
      const frames: Array<{ type: string; state?: { runState: AgentRunState } }> = [];
      const stop = wrapper.onStreamEvent(record => frames.push(JSON.parse(record.data)), null); stop();
      const run = frames.find(frame => frame.type === "session_snapshot")!.state!.runState;
      expect(run).toEqual({ ...first, lastProgressAt: 15_000, observedAt: 130_000, phase: { kind: "thinking" } });
      expect(runState(await wrapper.send({ type: "get_state" }))!).toEqual(run);
      emit({ type: "tool_execution_start", toolCallId: "a", toolName: "read" });
      expect(wrapper.getStreamSnapshot().phase).toEqual({ kind: "running_tools", tools: [{ id: "a", name: "read", startedAt: 130_000 }] });
      emit({ type: "tool_execution_end", toolCallId: "a" });
      emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Answer" }] } });
      expect(wrapper.getStreamSnapshot().phase).toEqual({ kind: "writing" });
      emit({ type: "message_end" });
      expect(wrapper.getStreamSnapshot().phase).toEqual({ kind: "waiting_model" });
      emit({ type: "agent_end", messages: [] });
      expect(runState(wrapper.getStreamSnapshot().state)!).toBeNull();
      vi.setSystemTime(140_000); emit({ type: "agent_start" });
      const next = runState(wrapper.getStreamSnapshot().state)!;
      expect(next.id).not.toBe(first.id); expect(next.startedAt).toBe(140_000);
    } finally { wrapper.destroy(); vi.useRealTimers(); }
  });

  it("retains one clock through scheduled SDK retries and clears it on cancellation", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const { wrapper, emit } = fixture();
    try {
      emit({ type: "agent_start" });
      const first = runState(wrapper.getStreamSnapshot().state)!;
      emit({ type: "agent_end", willRetry: true, messages: [{ role: "assistant", stopReason: "error" }] });
      vi.setSystemTime(12_000);
      emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 5000 });
      expect(runState(wrapper.getStreamSnapshot().state)).toMatchObject({ id: first.id, startedAt: 10_000, retry: { retryAt: 17_000 } });
      emit({ type: "agent_start" });
      expect(runState(wrapper.getStreamSnapshot().state)?.id).toBe(first.id);
      emit({ type: "auto_retry_end", success: false, finalError: "Retry cancelled" });
      expect(runState(wrapper.getStreamSnapshot().state)).toBeNull();
      expect(wrapper.getStreamSnapshot().lastRunOutcome).toBe("stopped");
    } finally { wrapper.destroy(); vi.useRealTimers(); }
  });

  it("reports continuation only after the committed SDK marker, restoring it on reconnect", () => {
    const { wrapper, emit } = fixture();
    let entries: unknown[] = [];
    Object.assign(wrapper.inner.sessionManager, { getBranch: () => entries });
    try {
      emit({ type: "agent_start" }); emit({ type: "turn_start" });
      expect(runState(wrapper.getStreamSnapshot().state)?.continuing).toBeUndefined();
      entries = [{ type: "custom_message", customType: "pi-web-output-continuation", display: false }];
      emit({ type: "turn_start" });
      expect(runState(wrapper.getStreamSnapshot().state)?.continuing).toBe(true);
      emit({ type: "message_start", message: { role: "user", content: "new direction" } });
      expect(runState(wrapper.getStreamSnapshot().state)?.continuing).toBeUndefined();
    } finally { wrapper.destroy(); }
  });

  it("replays live compact retry status in snapshots without a second request", async () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000);
    const { wrapper, emit } = fixture();
    try {
      emit({ type: "compaction_start", reason: "threshold" });
      vi.setSystemTime(105_000);
      emit({ type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "temporary failure" });
      const frames: Array<{ type: string; state?: { compaction?: { startedAt: number; observedAt: number; retry?: { status: string } } } }> = [];
      const off = wrapper.onStreamEvent(record => frames.push(JSON.parse(record.data)), null); off();
      expect(frames.find(frame => frame.type === "session_snapshot")?.state?.compaction).toMatchObject({ startedAt: 100_000, observedAt: 105_000, retry: { status: "waiting" } });
      emit({ type: "summarization_retry_attempt_start", source: "compaction", reason: "threshold" });
      expect((await wrapper.send({ type: "get_state" }) as { compaction: unknown }).compaction).toMatchObject({ retry: { status: "retrying" } });
      emit({ type: "summarization_retry_finished" });
      emit({ type: "compaction_end", result: { tokensBefore: 20, estimatedTokensAfter: 5 } });
      expect((await wrapper.send({ type: "get_state" }) as { compaction: unknown }).compaction).toMatchObject({ status: "completed" });
    } finally { wrapper.destroy(); vi.useRealTimers(); }
  });

  it("restores stopping and resets it if abort fails or the run ends", async () => {
    const { wrapper, emit } = fixture();
    try {
      emit({ type: "agent_start" });
      Object.assign(wrapper.inner, { abort: vi.fn().mockRejectedValue(new Error("abort failed")) });
      await expect(wrapper.send({ type: "abort" })).rejects.toThrow("abort failed");
      expect(wrapper.getStreamSnapshot().phase).toEqual({ kind: "waiting_model" });
      let finish!: () => void;
      Object.assign(wrapper.inner, { abort: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })) });
      const stopping = wrapper.send({ type: "abort" });
      expect(wrapper.getStreamSnapshot().phase).toEqual({ kind: "stopping" });
      emit({ type: "agent_end", messages: [] }); finish(); await stopping;
      expect(runState(wrapper.getStreamSnapshot().state)!).toBeNull();
    } finally { wrapper.destroy(); }
  });

  it.each(["length", "stop"])("retains %s output failure on reconnect and clears it for the next run", stopReason => {
    const { wrapper, emit } = fixture();
    try {
      emit({ type: "agent_start" });
      emit({ type: "agent_end", messages: [{ role: "assistant", stopReason, content: [] }] });
      expect(wrapper.getStreamSnapshot().lastRunError).toBe(stopReason === "length" ? "Output token limit reached" : "Model finished without a visible answer");
      emit({ type: "agent_start" });
      expect(wrapper.getStreamSnapshot().lastRunError).toBeNull();
    } finally { wrapper.destroy(); }
  });

  it("does not stream or replay internal system messages as chat bubbles", () => {
    const { wrapper, emit } = fixture();
    try {
      const records: Array<{ id?: string; data: string }> = [];
      wrapper.onStreamEvent((record) => records.push(record), null);
      emit({ type: "agent_start" });
      const cursor = records.at(-1)!.id!;
      const partial = { role: "assistant", content: [{ type: "text", text: "working" }] };
      emit({ type: "message_update", message: partial });
      for (const type of ["message_start", "message_update", "message_end"]) {
        emit({ type, message: { role: "system", content: "internal prompt", tools: [] } });
        expect(wrapper.getStreamSnapshot().streamingMessage).toEqual(partial);
      }
      expect(JSON.stringify(records)).not.toContain("internal prompt");
      const replay: typeof records = [];
      wrapper.onStreamEvent((record) => replay.push(record), cursor);
      expect(JSON.stringify(replay)).not.toContain("internal prompt");
    } finally { wrapper.destroy(); }
  });

  it("closes pending questions before the terminal SSE frame and disposes only once", async () => {
    const bridge = new WebExtensionUIBridge();
    const dispose = vi.fn();
    const inner = { sessionId: "closing-ui", sessionFile: "", dispose } as unknown as AgentSessionLike;
    const wrapper = new AgentSessionWrapper(inner, "", undefined, [], undefined, bridge);
    const frames: Array<{ type: string; reason?: string }> = [];
    wrapper.onStreamEvent(record => frames.push(JSON.parse(record.data)), null);
    const pending = bridge.askUser([{ id: "target", question: "Where?", options: [], allowOther: true }]);
    wrapper.destroy();
    wrapper.destroy();
    await expect(pending).resolves.toBeUndefined();
    expect(frames.map(frame => frame.type)).toEqual(["session_snapshot", "extension_ui_request", "extension_ui_closed", "session_closed"]);
    expect(frames.at(-2)?.reason).toBe("session_closed");
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("replays a lost final message and end exactly once before the idle snapshot", () => {
    const { wrapper, emit } = fixture();
    try {
      const initial: Array<{ id?: string; data: string }> = [];
      const off = wrapper.onStreamEvent((record) => initial.push(record), null);
      emit({ type: "agent_start" });
      const cursor = initial.at(-1)!.id!;
      off();
      emit({ type: "message_end", message: { role: "assistant", content: "done" } });
      emit({ type: "agent_end", messages: [] });
      const resumed: typeof initial = [];
      const offAgain = wrapper.onStreamEvent((record) => resumed.push(record), cursor);
      expect(resumed.map((record) => JSON.parse(record.data).type)).toEqual(["message_end", "agent_end", "session_snapshot"]);
      const snapshot = JSON.parse(resumed.at(-1)!.data);
      expect(snapshot.state.isStreaming).toBe(false);
      expect(snapshot.replayStatus).toBe("replayed");
      const checkpoint = resumed.at(-1)!.id!;
      offAgain();
      const duplicate: typeof initial = [];
      wrapper.onStreamEvent((record) => duplicate.push(record), checkpoint);
      expect(duplicate.map((record) => JSON.parse(record.data).type)).toEqual(["session_snapshot"]);
    } finally { wrapper.destroy(); }
  });

  it("uses a current snapshot for an unknown epoch or an evicted cursor", () => {
    const { wrapper, emit } = fixture();
    try {
      const first: Array<{ id?: string; data: string }> = [];
      const off = wrapper.onStreamEvent((record) => first.push(record), null);
      const oldCursor = first.at(-1)!.id!;
      off();
      emit({ type: "agent_start" });
      for (let index = 0; index < 600; index++) emit({ type: "message_update", message: { role: "assistant", content: `partial ${index}` } });
      for (const cursor of [oldCursor, "old-runtime:1"]) {
        const frames: typeof first = [];
        const unsubscribe = wrapper.onStreamEvent((record) => frames.push(record), cursor);
        expect(frames).toHaveLength(1);
        const snapshot = JSON.parse(frames[0].data);
        expect(snapshot.replayStatus).toBe("reset");
        expect(snapshot.state.isStreaming).toBe(true);
        expect(snapshot.streamingMessage.content).toBe("partial 599");
        unsubscribe();
      }
    } finally { wrapper.destroy(); }
  });

  it("copies retained events so later SDK object mutation cannot rewrite history", () => {
    const { wrapper, emit } = fixture();
    try {
      const initial: Array<{ id?: string; data: string }> = [];
      const off = wrapper.onStreamEvent((record) => initial.push(record), null);
      const cursor = initial.at(-1)!.id!;
      off();
      const message = { role: "assistant", content: "first" };
      emit({ type: "message_update", message });
      message.content = "mutated";
      const resumed: typeof initial = [];
      wrapper.onStreamEvent((record) => resumed.push(record), cursor);
      expect(JSON.parse(resumed[0].data).message.content).toBe("first");
    } finally { wrapper.destroy(); }
  });

  it("keeps immediate prompt rejection observable in both replay and the idle snapshot", async () => {
    const inner = { sessionId: "rejected", sessionFile: "", prompt: vi.fn().mockRejectedValue(new Error("No model configured")), dispose: vi.fn() } as unknown as AgentSessionLike;
    const wrapper = new AgentSessionWrapper(inner);
    try {
      const initial: Array<{ id?: string; data: string }> = [];
      const off = wrapper.onStreamEvent((record) => initial.push(record), null);
      const cursor = initial[0].id!; off();
      await wrapper.send({ type: "prompt", message: "fixture" });
      const replay: typeof initial = [];
      wrapper.onStreamEvent((record) => replay.push(record), cursor);
      expect(replay.map((record) => JSON.parse(record.data).type)).toEqual(["agent_end", "session_snapshot"]);
      expect(JSON.parse(replay[1].data)).toMatchObject({ lastRunError: "No model configured", state: { isStreaming: false } });
    } finally { wrapper.destroy(); }
  });

  it("does not replay delivered one-shot editor commands, but restores pending dialogs", () => {
    const bridge = new WebExtensionUIBridge({ emit: vi.fn() });
    const inner = { sessionId: "ui", sessionFile: "", dispose: vi.fn() } as unknown as AgentSessionLike;
    const wrapper = new AgentSessionWrapper(inner, "", undefined, [], undefined, bridge);
    try {
      const initial: Array<{ id?: string; data: string }> = [];
      const off = wrapper.onStreamEvent((record) => initial.push(record), null);
      const cursor = initial[0].id!;
      bridge.setEditorText("draft sent once");
      void bridge.select("Pick", ["A", "B"]);
      expect(initial.some((record) => JSON.parse(record.data).method === "set_editor_text")).toBe(true);
      off();
      const replay: typeof initial = [];
      wrapper.onStreamEvent((record) => replay.push(record), cursor);
      expect(replay.some((record) => JSON.parse(record.data).method === "set_editor_text")).toBe(false);
      expect(replay.some((record) => JSON.parse(record.data).method === "select")).toBe(true);
      expect(replay.filter((record) => JSON.parse(record.data).type.startsWith("extension_ui_")).every((record) => record.id === undefined)).toBe(true);
    } finally { wrapper.destroy(); }
  });
});
