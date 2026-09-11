import { describe, expect, it, vi } from "vitest";
import { AgentSessionWrapper } from "../rpc-manager";
import type { AgentSessionLike } from "../pi-types";
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

describe("agent SSE replay contract", () => {
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
