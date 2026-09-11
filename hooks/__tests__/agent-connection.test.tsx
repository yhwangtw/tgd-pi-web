// @vitest-environment jsdom
import { act, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentEvents } from "../use-agent-connection";
import type { AgentEvent } from "../use-agent-session-types";

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
  message(event: AgentEvent, id = "") { this.onmessage?.({ data: JSON.stringify(event), lastEventId: id }); }
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
    const pending = connection.connectEvents("one").then((ok) => { resolved = ok; return ok; });
    const source = FakeEventSource.instances[0];
    await act(async () => source.open());
    expect(resolved).toBe(false);
    await act(async () => source.message({ type: "session_snapshot", state: { isStreaming: false } }, "epoch:0"));
    await expect(pending).resolves.toBe(true);
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: "session_snapshot" }));
  });

  it("resumes with the last cursor, deduplicates events, and still applies same-cursor snapshots and UI state", async () => {
    void connection.connectEvents("one");
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

  it("cancels old reconnect timers on a session switch and after unmount", async () => {
    void connection.connectEvents("one");
    await act(async () => FakeEventSource.instances[0].onerror?.());
    void connection.connectEvents("two");
    await act(async () => vi.advanceTimersByTime(2000));
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].url).not.toContain("cursor=");
    await act(async () => FakeEventSource.instances[1].onerror?.());
    await act(async () => root.unmount());
    await act(async () => vi.advanceTimersByTime(20_000));
    expect(FakeEventSource.instances).toHaveLength(2);
    await expect(connection.connectEvents("late-load-result")).resolves.toBe(false);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("reopens a disposed idle runtime instead of reusing its dead stream", async () => {
    void connection.connectEvents("one");
    const first = FakeEventSource.instances[0];
    await act(async () => { first.open(); first.message({ type: "session_snapshot" }, "epoch:0"); first.message({ type: "session_closed" }, "epoch:1"); });
    expect(first.readyState).toBe(FakeEventSource.CLOSED);
    void connection.connectEvents("one");
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].url).toContain("cursor=epoch%3A1");
  });
});
