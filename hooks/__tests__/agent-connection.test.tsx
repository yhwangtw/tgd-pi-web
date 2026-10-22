// @vitest-environment jsdom
import { act, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentEvents } from "../use-agent-connection";
import { createAgentMessageDelta } from "@/lib/agent-stream-wire";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
  static OPEN = 1; static CONNECTING = 0; static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  constructor(readonly url: string) { FakeEventSource.instances.push(this); }
  close() { this.readyState = FakeEventSource.CLOSED; }
  open() { this.readyState = FakeEventSource.OPEN; this.onopen?.(); }
  message(event: unknown, id = "") { this.onmessage?.({ data: JSON.stringify(event), lastEventId: id }); }
}

describe("agent connection resume", () => {
  let root: Root;
  let container: HTMLDivElement;
  let connection: ReturnType<typeof useAgentEvents>;
  const events = vi.fn();
  function Harness() {
    const running = useRef(true);
    const handler = useRef(events);
    const value = useAgentEvents(running, handler);
    useEffect(() => { connection = value; }, [value]);
    return null;
  }
  function connect(sid: string) {
    let pending!: Promise<boolean>;
    act(() => { pending = connection.connectEvents(sid); });
    return pending;
  }
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    FakeEventSource.instances = [];
    events.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<Harness />));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers(); vi.unstubAllGlobals();
  });

  it("waits for snapshot reconciliation before reporting a ready stream", async () => {
    let resolved = false;
    const pending = connect("one").then((ok) => { resolved = ok; return ok; });
    const source = FakeEventSource.instances[0];
    await act(async () => source.open());
    expect(resolved).toBe(false);
    await act(async () => source.message({ type: "session_snapshot", state: { isStreaming: false } }, "epoch:0"));
    await expect(pending).resolves.toBe(true);
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: "session_snapshot" }));
  });

  it("resumes with the last cursor, deduplicates events, and still applies same-cursor snapshots and UI state", async () => {
    void connect("one");
    const first = FakeEventSource.instances[0];
    await act(async () => {
      first.open(); first.message({ type: "session_snapshot" }, "epoch:0");
      first.message({ type: "agent_start" }, "epoch:1");
      first.onerror?.();
    });
    await act(async () => vi.advanceTimersByTime(1000));
    const resumed = FakeEventSource.instances[1];
    expect(resumed.url).toContain("cursor=epoch%3A1");
    await act(async () => {
      resumed.open();
      resumed.message({ type: "agent_start" }, "epoch:1");
      resumed.message({ type: "agent_end" }, "epoch:2");
      resumed.message({ type: "session_snapshot", state: { isStreaming: false } }, "epoch:2");
      resumed.message({ type: "extension_ui_request", method: "set_status" }, "epoch:2");
      first.message({ type: "stale_source" }, "epoch:999");
    });
    expect(events.mock.calls.map(([event]) => event.type)).toEqual(["session_snapshot", "agent_start", "agent_end", "session_snapshot", "extension_ui_request"]);
  });

  it("delivers unsequenced run timings even when EventSource inherits the last sequenced cursor", async () => {
    void connect("one");
    const source = FakeEventSource.instances[0];
    await act(async () => {
      source.message({ type: "session_snapshot" }, "epoch:0");
      source.message({ type: "agent_start" }, "epoch:1");
      source.message({ type: "run_timing", phase: "first_event", elapsedMs: 12 }, "epoch:1");
      source.message({ type: "agent_end" }, "epoch:2");
      source.message({ type: "run_timing", phase: "complete", elapsedMs: 50 }, "epoch:2");
      source.onerror?.();
    });
    expect(events.mock.calls.map(([event]) => event.type)).toEqual(["session_snapshot", "agent_start", "run_timing", "agent_end", "run_timing"]);
    await act(async () => vi.advanceTimersByTime(1000));
    expect(FakeEventSource.instances[1].url).toContain("cursor=epoch%3A2");
  });

  it("negotiates deltas and reconstructs complete events before delivery, ignoring duplicate deltas", async () => {
    void connect("one");
    const source = FakeEventSource.instances[0];
    expect(source.url).toContain("stream=delta-v1");
    const initial = { type: "message_update", message: { role: "assistant", content: "x".repeat(2000), usage: { output: 1 } } };
    const next = { ...initial, message: { ...initial.message, content: initial.message.content + "台灣", usage: { output: 2 } } };
    const delta = JSON.parse(createAgentMessageDelta(JSON.stringify(initial), JSON.stringify(next), "epoch:1"));
    await act(async () => {
      source.message({ type: "session_snapshot" }, "epoch:0");
      source.message(initial, "epoch:1");
      source.message(delta, "epoch:2");
      source.message(delta, "epoch:2");
      source.message({ type: "message_end", message: next.message }, "epoch:3");
    });
    expect(events.mock.calls.map(([event]) => event.type)).toEqual(["session_snapshot", "message_update", "message_update", "message_end"]);
    expect(events.mock.calls[2][0]).toEqual(next);
  });

  it.each(["base", "malformed", "json"])("requests a cursorless full snapshot after %s corruption and cannot endlessly retry deltas", async failure => {
    void connect("one");
    const source = FakeEventSource.instances[0];
    const initial = { type: "message_update", message: { content: "x".repeat(1000) } };
    const next = { type: "message_update", message: { content: "x".repeat(1000) + "next" } };
    const broken = JSON.parse(createAgentMessageDelta(JSON.stringify(initial), JSON.stringify(next), failure === "base" ? "missing:1" : "epoch:1"));
    if (failure === "malformed") broken.edits = [{ start: -1, remove: 0, insert: "" }];
    await act(async () => {
      source.message({ type: "session_snapshot" }, "epoch:0"); source.message(initial, "epoch:1");
      if (failure === "json") source.onmessage?.({ data: "{bad", lastEventId: "epoch:2" });
      else source.message(broken, "epoch:2");
    });
    expect(source.readyState).toBe(FakeEventSource.CLOSED);
    expect(events).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTime(0));
    const recovered = FakeEventSource.instances[1];
    expect(recovered.url).not.toContain("cursor=");
    expect(recovered.url).not.toContain("stream=delta-v1");
    await act(async () => {
      recovered.message({ type: "session_snapshot", streamingMessage: next.message }, "epoch:2");
      recovered.message(next, "epoch:3");
    });
    expect(events.mock.calls[2][0]).toMatchObject({ type: "session_snapshot", streamingMessage: next.message });
    expect(events.mock.calls[3][0]).toEqual(next);
    // A server violating the full-frame downgrade gets one recovery, not an
    // immediate cursorless reconnect loop. Manual reconnect remains available.
    await act(async () => { recovered.message(broken, "epoch:4"); vi.advanceTimersByTime(5000); });
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(recovered.readyState).toBe(FakeEventSource.CLOSED);
  });

  it("cancels snapshot recovery on a session switch and negotiates afresh in the new session", async () => {
    void connect("one");
    await act(async () => FakeEventSource.instances[0].onmessage?.({ data: "bad json", lastEventId: "epoch:1" }));
    void connect("two");
    await act(async () => vi.advanceTimersByTime(0));
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].url).toContain("stream=delta-v1");
    expect(FakeEventSource.instances[1].url).not.toContain("cursor=");
  });

  it("cancels old reconnect timers on a session switch and after unmount", async () => {
    void connect("one");
    await act(async () => FakeEventSource.instances[0].onerror?.());
    void connect("two");
    await act(async () => vi.advanceTimersByTime(2000));
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].url).not.toContain("cursor=");
    await act(async () => FakeEventSource.instances[1].onerror?.());
    await act(async () => root.unmount());
    await act(async () => vi.advanceTimersByTime(20_000));
    expect(FakeEventSource.instances).toHaveLength(2);
    await expect(connect("late-load-result")).resolves.toBe(false);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("reopens a disposed idle runtime instead of reusing its dead stream", async () => {
    void connect("one");
    const first = FakeEventSource.instances[0];
    await act(async () => { first.open(); first.message({ type: "session_snapshot" }, "epoch:0"); first.message({ type: "session_closed" }, "epoch:1"); });
    expect(first.readyState).toBe(FakeEventSource.CLOSED);
    void connect("one");
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].url).toContain("cursor=epoch%3A1");
  });
});
