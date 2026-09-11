import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ subscribe: vi.fn(), unsubscribe: vi.fn(), get: vi.fn(), resume: vi.fn(), start: vi.fn(), resolve: vi.fn() }));
vi.mock("@/lib/rpc-manager", () => ({ getRpcSession: harness.get, getResumableRpcSession: harness.resume, startRpcSession: harness.start }));
vi.mock("@/lib/session-reader", () => ({ resolveSessionPath: harness.resolve }));
import { GET } from "../../app/api/agent/[id]/events/route";

describe("agent events HTTP replay transport", () => {
  beforeEach(() => {
    vi.useFakeTimers(); harness.subscribe.mockReset(); harness.unsubscribe.mockReset();
    harness.resume.mockReset(); harness.start.mockReset(); harness.resolve.mockReset();
    harness.get.mockReturnValue({ isAlive: () => true, onStreamEvent: harness.subscribe });
    harness.subscribe.mockImplementation((listener) => {
      listener({ id: "epoch:3", data: JSON.stringify({ type: "message_end", message: "complete" }) });
      listener({ id: "epoch:3", data: JSON.stringify({ type: "session_snapshot", state: { isStreaming: false } }) });
      return harness.unsubscribe;
    });
  });
  afterEach(() => { vi.useRealTimers(); });

  it("honors Last-Event-ID before query cursor and frames replay records with SSE ids", async () => {
    const response = await GET(new Request("http://localhost/api/agent/one/events?cursor=query:1", { headers: { "Last-Event-ID": "epoch:2" } }), { params: Promise.resolve({ id: "one" }) });
    expect(harness.subscribe).toHaveBeenCalledWith(expect.any(Function), "epoch:2");
    const reader = response.body!.getReader();
    const decode = new TextDecoder();
    const frames = [];
    for (let index = 0; index < 3; index++) frames.push(decode.decode((await reader.read()).value));
    expect(frames[0]).toBe('data: {"type":"connected","sessionId":"one"}\n\n');
    expect(frames[1]).toContain('id: epoch:3\ndata: {"type":"message_end"');
    expect(frames[2]).toContain('id: epoch:3\ndata: {"type":"session_snapshot"');
    await reader.cancel();
    expect(harness.unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("supports manual reconnect cursors and releases the listener on request abort", async () => {
    const abort = new AbortController();
    const response = await GET(new Request("http://localhost/api/agent/one/events?cursor=epoch%3A1", { signal: abort.signal }), { params: Promise.resolve({ id: "one" }) });
    expect(harness.subscribe).toHaveBeenCalledWith(expect.any(Function), "epoch:1");
    abort.abort();
    expect(harness.unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await response.body!.cancel();
    expect(harness.unsubscribe).toHaveBeenCalledOnce();
  });

  it("recovers a lost replacement event and POST response from the old cursor without reopening its old file", async () => {
    harness.get.mockReturnValue(undefined);
    const moved = { sessionId: "next", cwd: "/fixture/new", sessionFile: "/fixture/new.jsonl", isAlive: () => true, isReplacementPending: () => false, onStreamEvent: harness.subscribe };
    harness.resume.mockReturnValue(moved);
    harness.subscribe.mockImplementation((listener) => { listener({ id: "epoch:9", data: JSON.stringify({ type: "session_snapshot", sessionId: "next", state: { isStreaming: false } }) }); return harness.unsubscribe; });
    const response = await GET(new Request("http://localhost/api/agent/old/events?cursor=epoch%3A2"), { params: Promise.resolve({ id: "old" }) });
    expect(response.status).toBe(200);
    expect(harness.resume).toHaveBeenCalledWith("old", "epoch:2");
    expect(harness.resolve).not.toHaveBeenCalled(); expect(harness.start).not.toHaveBeenCalled();
    expect(harness.subscribe).toHaveBeenCalledWith(expect.any(Function), null);
    const reader = response.body!.getReader(); const frames: string[] = []; const decode = new TextDecoder();
    for (let index = 0; index < 3; index++) frames.push(decode.decode((await reader.read()).value));
    expect(frames[1]).toContain('"type":"session_replaced","previousSessionId":"old","newSessionId":"next"');
    expect(frames[2]).toContain('"type":"session_snapshot","sessionId":"next"');
    await reader.cancel();
  });

  it("waits through an unfinished runtime replacement instead of exposing a transient session", async () => {
    harness.get.mockReturnValue(undefined);
    harness.resume.mockReturnValue({ isAlive: () => true, isReplacementPending: () => true });
    const response = await GET(new Request("http://localhost/api/agent/old/events?cursor=epoch%3A2"), { params: Promise.resolve({ id: "old" }) });
    expect(response.status).toBe(503);
    expect(harness.subscribe).not.toHaveBeenCalled(); expect(harness.resolve).not.toHaveBeenCalled();
  });

  it("never looks up replacement aliases when intentionally opening an old session without a cursor", async () => {
    const response = await GET(new Request("http://localhost/api/agent/old/events"), { params: Promise.resolve({ id: "old" }) });
    expect(response.status).toBe(200);
    expect(harness.resume).not.toHaveBeenCalled();
    expect(harness.get).toHaveBeenCalledWith("old");
    expect(harness.subscribe).toHaveBeenCalledWith(expect.any(Function), null);
    await response.body!.cancel();
  });
});
