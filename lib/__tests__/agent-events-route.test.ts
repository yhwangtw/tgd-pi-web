import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ subscribe: vi.fn(), unsubscribe: vi.fn(), get: vi.fn(), durable: vi.fn(), resume: vi.fn(), start: vi.fn(), resolve: vi.fn() }));
vi.mock("@/lib/rpc-manager", () => ({ getRpcSession: harness.get, getResumableRpcSession: harness.resume, startRpcSession: harness.start }));
vi.mock("@/lib/session-reader", () => ({ resolveSessionPath: harness.resolve }));
vi.mock("@/lib/durable-chat", () => ({ getDurableChat: harness.durable, openDurableChat: vi.fn() }));
import { GET } from "../../app/api/agent/[id]/events/route";
import { decodeSessionData, encodeSessionData } from "../session-tree-wire";
import type { SessionTreeNode } from "../types";
import { AgentEventLog, type AgentStreamRecord } from "../agent-event-log";
import { AgentStreamDecoder } from "../agent-stream-wire";

describe("agent events HTTP replay transport", () => {
  beforeEach(() => {
    vi.useFakeTimers(); harness.subscribe.mockReset(); harness.unsubscribe.mockReset();
    harness.resume.mockReset(); harness.start.mockReset(); harness.resolve.mockReset(); harness.durable.mockReset();
    harness.get.mockReturnValue({ isAlive: () => true, onStreamEvent: harness.subscribe });
    harness.subscribe.mockImplementation((listener) => {
      listener({ id: "epoch:3", data: JSON.stringify({ type: "message_end", message: "complete" }) });
      listener({ id: "epoch:3", data: JSON.stringify({ type: "session_snapshot", state: { isStreaming: false } }) });
      return harness.unsubscribe;
    });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

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

  it("routes typed frames without parsing their full payload and still closes terminal streams", async () => {
    const snapshotData = JSON.stringify({ type: "session_snapshot", sessionData: { context: { messages: ["x".repeat(200_000)] } } });
    const closedData = JSON.stringify({ type: "session_closed" });
    const parse = vi.spyOn(JSON, "parse");
    let deliver: ((record: { type: string; data: string }) => void) | undefined;
    harness.subscribe.mockImplementation((listener) => {
      deliver = listener;
      listener({ id: "epoch:4", type: "session_snapshot", data: snapshotData });
      return harness.unsubscribe;
    });
    const response = await GET(new Request("http://localhost/api/agent/one/events?tree=flat-v2"), { params: Promise.resolve({ id: "one" }) });
    expect(parse.mock.calls.some(([data]) => data === snapshotData)).toBe(false);
    deliver!({ type: "session_closed", data: closedData });
    await Promise.resolve();
    expect(parse.mock.calls.some(([data]) => data === closedData)).toBe(false);
    expect(harness.unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await response.body!.cancel();
    expect(harness.unsubscribe).toHaveBeenCalledOnce();
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

  it("keeps pre-upgrade tabs on the nested snapshot contract until they reload", async () => {
    const data = encodeSessionData({ tree: [{ entry: { type: "session_info" as const, id: "one", parentId: null, timestamp: "2026-10-22T00:00:00Z", name: "Old tab" }, children: [] }] });
    harness.subscribe.mockImplementation(listener => {
      listener({ id: "epoch:4", type: "session_snapshot", data: JSON.stringify({ type: "session_snapshot", protocolVersion: 2, sessionData: data }) });
      return harness.unsubscribe;
    });
    const response = await GET(new Request("http://localhost/api/agent/one/events"), { params: Promise.resolve({ id: "one" }) });
    const reader = response.body!.getReader(); await reader.read();
    const frame = new TextDecoder().decode((await reader.read()).value);
    const snapshot = JSON.parse(frame.split("data: ")[1]);
    expect(snapshot.protocolVersion).toBe(1);
    expect(snapshot.sessionData.tree[0].entry.id).toBe("one");
    await reader.cancel();
  });

  it.each([undefined, "flat-v1", "flat-v2"])("negotiates compact snapshots for %s clients without changing replay fields", async format => {
    const message = { role: "user" as const, content: "One full message", timestamp: 1 };
    const tree: SessionTreeNode[] = [{ entry: { type: "message", id: "one", parentId: null, timestamp: "now", message }, children: [], label: "Branch" }];
    const original = { sessionId: "one", leafId: "one", tree, context: { entryIds: ["one"], messages: [{ ...message }] } };
    const data = encodeSessionData(original, "flat-v2");
    const snapshot = { type: "session_snapshot", protocolVersion: 2, replayStatus: "reset", cursor: "epoch:4", sessionData: data,
      state: { isStreaming: true }, streamingMessage: message, phase: { kind: "thinking" }, lastRunError: null };
    harness.subscribe.mockImplementation(listener => {
      listener({ id: "epoch:4", type: "session_snapshot", data: JSON.stringify(snapshot) }); return harness.unsubscribe;
    });
    const response = await GET(new Request(`http://localhost/api/agent/one/events${format ? `?tree=${format}` : ""}`), { params: Promise.resolve({ id: "one" }) });
    const reader = response.body!.getReader(); await reader.read();
    const frame = new TextDecoder().decode((await reader.read()).value);
    expect(frame).toContain("id: epoch:4\n");
    const restored = JSON.parse(frame.split("data: ")[1]);
    expect(restored).toEqual({ ...snapshot, protocolVersion: format ? 2 : 1, sessionData: format === "flat-v2" ? data : format ? encodeSessionData(original) : original });
    expect(decodeSessionData(restored.sessionData)).toEqual(original);
    await reader.cancel(); expect(harness.unsubscribe).toHaveBeenCalledOnce();
  });

  it.each(["standard", "durable"])("negotiates exact incremental updates for %s, preserving cursor replay and full snapshots", async engine => {
    const log = new AgentEventLog("delta");
    const update = (text: string) => ({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text }] } });
    const first = log.append(update("x".repeat(4000)));
    const second = log.append(update("x".repeat(4000) + "2"));
    const third = log.append(update("x".repeat(4000) + "3"));
    const snapshot = { id: third.id, type: "session_snapshot", data: JSON.stringify({ type: "session_snapshot", streamingMessage: update("snapshot").message }) };
    const fourth = log.append(update("x".repeat(4000) + "4"));
    const fifth = log.append(update("x".repeat(4000) + "5"));
    const end = log.append({ type: "message_end", message: update("complete").message });
    let deliver!: (record: AgentStreamRecord) => void;
    harness.subscribe.mockImplementation(listener => { deliver = listener; for (const record of [second, third, snapshot]) listener(record); return harness.unsubscribe; });
    const sid = engine === "durable" ? "dw_00000000-0000-0000-0000-000000000000_1" : "one";
    if (engine === "durable") harness.durable.mockReturnValue({ sessionId: sid, isAlive: () => true, resume: async () => {}, onStreamEvent: harness.subscribe });
    const response = await GET(new Request(`http://localhost/api/agent/${sid}/events?tree=flat-v2&stream=delta-v1&cursor=${encodeURIComponent(first.id!)}`), { params: Promise.resolve({ id: sid }) });
    deliver(fourth); deliver(fifth); deliver(end);
    const reader = response.body!.getReader(); await reader.read();
    const decoder = new AgentStreamDecoder();
    const native = [second, third, snapshot, fourth, fifth, end];
    const types: string[] = [];
    for (const original of native) {
      const frame = new TextDecoder().decode((await reader.read()).value);
      const data = frame.split("data: ")[1].trim();
      types.push(JSON.parse(data).type);
      expect(frame).toContain(`id: ${original.id}\n`);
      expect(decoder.decode(JSON.parse(data), data, original.id!)).toEqual(JSON.parse(original.data));
    }
    expect(types).toEqual(["message_update", "message_update_delta", "session_snapshot", "message_update", "message_update_delta", "message_end"]);
    expect(harness.subscribe).toHaveBeenCalledWith(expect.any(Function), first.id);
    await reader.cancel();
    expect(harness.unsubscribe).toHaveBeenCalledOnce();
  });

  it.each(["", "&stream=unknown"])("keeps exact legacy message frames without supported negotiation (%s)", async query => {
    const log = new AgentEventLog("legacy");
    const first = log.append({ type: "message_update", message: { content: "x".repeat(4000) } });
    const second = log.append({ type: "message_update", message: { content: "x".repeat(4000) + "y" } });
    expect(second.delta).toBeDefined();
    harness.subscribe.mockImplementation(listener => { listener(first); listener(second); return harness.unsubscribe; });
    const response = await GET(new Request(`http://localhost/api/agent/one/events?tree=flat-v2${query}`), { params: Promise.resolve({ id: "one" }) });
    const reader = response.body!.getReader(); await reader.read();
    for (const original of [first, second]) {
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(`id: ${original.id}\ndata: ${original.data}\n\n`);
    }
    await reader.cancel();
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
