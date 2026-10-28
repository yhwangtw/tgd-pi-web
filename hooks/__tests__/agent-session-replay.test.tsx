// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo, AgentMessage } from "@/lib/types";
import type { AgentEvent, SessionData } from "../use-agent-session-types";

const harness = vi.hoisted(() => ({ send: vi.fn(), toast: vi.fn(), created: vi.fn(), fetch: vi.fn(), rejectModel: vi.fn(), complete: vi.fn(), branchDataChange: vi.fn() }));
vi.mock("@/lib/agent-client", () => ({ sendAgentCommand: harness.send }));
vi.mock("@/hooks/useToast", () => ({ showToast: harness.toast }));
vi.mock("@/lib/attention", () => ({ setIdleTitle: vi.fn(), setRunningTitle: vi.fn(), setDoneTitle: vi.fn(), setErrorTitle: vi.fn(), setExtensionTitle: vi.fn(), notifyDone: vi.fn(), requestNotifyPermission: vi.fn() }));
vi.mock("../use-model-catalog", () => ({ useModelCatalog: () => ({ modelNames: {}, modelList: [], modelThinkingLevels: {}, modelThinkingLevelMaps: {}, newSessionModel: { provider: "fixture", modelId: "instant" }, setNewSessionModel: vi.fn(), catalogStatus: "ready", catalogDiagnostics: [], retryModelCatalog: vi.fn(), reportModelUnavailable: harness.rejectModel }) }));
import { useAgentSession } from "../useAgentSession";
import { setIdleTitle, setRunningTitle, setDoneTitle, setErrorTitle, notifyDone } from "@/lib/attention";
import { encodeSessionData } from "@/lib/session-tree-wire";
import { readRunLatencyRecords } from "@/lib/run-latency";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class FakeEventSource {
  static OPEN = 1; static CONNECTING = 0; static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null; onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  constructor(readonly url: string) { FakeEventSource.instances.push(this); }
  close() { this.readyState = FakeEventSource.CLOSED; }
  open() { this.readyState = FakeEventSource.OPEN; this.onopen?.(); }
  message(event: AgentEvent, id: string) { this.onmessage?.({ data: JSON.stringify(event), lastEventId: id }); }
}
const session: SessionInfo = { id: "one", path: "", cwd: "/fixture", name: "fixture", created: "", modified: "", messageCount: 0, firstMessage: "" };
const user: AgentMessage = { role: "user", content: "hello", timestamp: 1 };
const assistant = { role: "assistant", content: [{ type: "text", text: "instant answer" }], stopReason: "stop", timestamp: 2 } as AgentMessage;
function data(messages: AgentMessage[] = []): SessionData {
  return { sessionId: "one", filePath: "", tree: [], leafId: null, context: { messages, entryIds: messages.map((_, index) => `e${index}`), model: { provider: "fixture", modelId: "instant" }, thinkingLevel: "off" } };
}
function snapshot(messages: AgentMessage[], streaming = false): AgentEvent {
  return { type: "session_snapshot", sessionId: "one", sessionData: data(messages), state: { isStreaming: streaming }, streamingMessage: null };
}

describe("session reconciliation and first-prompt ordering", () => {
  let root: Root; let container: HTMLDivElement;
  let current: ReturnType<typeof useAgentSession>;
  let serverMessages: AgentMessage[];
  let serverStreaming: boolean;
  function Harness({ selected }: { selected: SessionInfo | null }) {
    const value = useAgentSession({ session: selected, newSessionCwd: selected ? null : "/fixture", onSessionCreated: harness.created, onAgentComplete: harness.complete, onBranchDataChange: harness.branchDataChange });
    useEffect(() => { current = value; }, [value]);
    return null;
  }
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers(); vi.stubGlobal("EventSource", FakeEventSource); vi.stubGlobal("fetch", harness.fetch);
    FakeEventSource.instances = []; serverMessages = []; serverStreaming = false;
    harness.send.mockReset(); harness.created.mockReset(); harness.toast.mockReset(); harness.fetch.mockReset();
    harness.rejectModel.mockReset(); harness.complete.mockReset(); harness.branchDataChange.mockReset();
    harness.send.mockResolvedValue(null);
    harness.fetch.mockImplementation(async (url: string) => {
      if (url === "/api/agent/new") return new Response(JSON.stringify({ sessionId: "one", deferred: true }));
      if (url.startsWith("/api/sessions/")) return new Response(JSON.stringify({ ...data(serverMessages), agentState: { running: true, state: { isStreaming: serverStreaming } } }));
      return new Response("{}");
    });
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("restores the same run and quiet duration on remount, reload and reconnect without sending a prompt", async () => {
    vi.setSystemTime(1_000_000);
    const run = { id: "run-one", startedAt: 10_000, lastProgressAt: 20_000, observedAt: 130_000, phase: { kind: "thinking" } as const };
    harness.fetch.mockImplementation(async () => new Response(JSON.stringify({ ...data(), agentState: { running: true, state: { isStreaming: true, runState: run } } })));
    await act(async () => root.render(<Harness key="one" selected={session} />));
    expect(current.agentStartedAt).toBe(880_000);
    expect(current.agentPhase).toEqual({ kind: "thinking" });
    expect(current.runProgress.attention).toBe("delayed");
    await act(async () => root.render(<Harness key="away" selected={null} />));
    vi.setSystemTime(1_010_000); run.observedAt += 10_000;
    await act(async () => root.render(<Harness key="back" selected={session} />));
    expect(current.agentStartedAt).toBe(880_000);
    const source = FakeEventSource.instances.at(-1)!;
    await act(async () => { source.open(); source.message({ ...snapshot([], true), state: { isStreaming: true, runState: run } }, "clock:1"); });
    expect(current.agentStartedAt).toBe(880_000);
    expect(current.agentPhase).toEqual({ kind: "thinking" });
    expect(current.runProgress.idleSeconds).toBe(120);
    // Even a delayed response must not make the elapsed counter go backwards.
    await act(async () => source.message({ ...snapshot([], true), state: { isStreaming: true, runState: { ...run, observedAt: run.observedAt - 1000 } } }, "clock:1"));
    expect(current.agentStartedAt).toBe(880_000);
    const nextRun = { ...run, id: "run-two", startedAt: run.observedAt, lastProgressAt: run.observedAt, phase: { kind: "waiting_model" } };
    await act(async () => source.message({ type: "agent_start", runState: nextRun }, "clock:2"));
    expect(current.agentStartedAt).toBe(1_010_000);
    await act(async () => source.message({ type: "agent_end", messages: [] }, "clock:3"));
    expect(current.agentStartedAt).toBeNull();
    expect(harness.send.mock.calls.some(([, command]) => command.type === "prompt")).toBe(false);
  });

  it("does not show a fabricated zero-second clock when reconnecting to an older server", async () => {
    serverStreaming = true;
    await act(async () => root.render(<Harness selected={session} />));
    expect(current.agentStartedAt).toBeNull();
    await act(async () => current.handleAgentEventRef.current?.(snapshot([], true)));
    expect(current.agentStartedAt).toBeNull();
  });

  it("reconciles resolved compaction settings from load, snapshots and optimistic toggle rollback", async () => {
    const persisted = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 };
    const live = { enabled: false, reserveTokens: 8_192, keepRecentTokens: 12_000 };
    harness.fetch.mockImplementation(async (url: string) => new Response(JSON.stringify(url.startsWith("/api/sessions/")
      ? { ...data(), compactionSettings: persisted, agentState: { running: true, state: { compactionSettings: live } } } : {})));
    await act(async () => root.render(<Harness selected={session} />));
    expect(current.compactionSettings).toEqual(live);
    expect(current.autoCompactionEnabled).toBe(false);
    const changed = { enabled: true, reserveTokens: 32_768, keepRecentTokens: 40_000 };
    await act(async () => current.handleAgentEventRef.current?.({ ...snapshot([]), state: { compactionSettings: changed } }));
    expect(current.compactionSettings).toEqual(changed);
    await act(async () => current.handleAutoCompactionChange(false));
    expect(current.compactionSettings).toEqual({ ...changed, enabled: false });
    harness.send.mockRejectedValueOnce(new Error("offline"));
    await act(async () => current.handleAutoCompactionChange(true));
    expect(current.compactionSettings).toEqual({ ...changed, enabled: false });
  });

  it("retains old messages when compaction completion reloads and a reconnect snapshot follows", async () => {
    const old = { role: "user", content: "Old history" } as AgentMessage;
    serverMessages = [old, assistant];
    await act(async () => root.render(<Harness selected={session} />));
    const note = { role: "custom", customType: "pi-web-compaction", display: true, content: "Summary" } as AgentMessage;
    serverMessages = [old, assistant, note];
    await act(async () => current.handleAgentEventRef.current?.({ type: "compaction_status", compaction: { id: "compact-history", status: "completed", reason: "manual", startedAt: 1, result: { tokensBefore: 40000 } } }));
    expect(current.messages).toEqual(serverMessages);
    await act(async () => current.handleAgentEventRef.current?.(snapshot(serverMessages)));
    expect(current.messages).toEqual(serverMessages);
    expect(current.messages.filter(message => message.role === "user")).toHaveLength(1);
  });

  it.each(["length", "stop"])("keeps %s no-answer runs out of success callbacks and restores the failure after reconnect", async stopReason => {
    await act(async () => root.render(<Harness selected={session} />));
    const emit = (event: AgentEvent) => act(async () => current.handleAgentEventRef.current?.(event));
    const failed = { ...assistant, stopReason, content: [] } as AgentMessage;
    await emit(snapshot([]));
    vi.mocked(setDoneTitle).mockClear(); vi.mocked(setErrorTitle).mockClear(); vi.mocked(notifyDone).mockClear();
    await emit({ type: "agent_start" });
    await emit({ type: "message_end", message: failed });
    await emit({ type: "agent_end", messages: [failed] });
    expect(current.agentRunning).toBe(false);
    expect(current.providerRecovery).toBeNull();
    expect(harness.complete).not.toHaveBeenCalled();
    expect(setDoneTitle).not.toHaveBeenCalled();
    expect(setErrorTitle).toHaveBeenCalled();
    expect(notifyDone).toHaveBeenCalledTimes(1);
    await emit({ type: "agent_end", messages: [failed], replayed: true });
    expect(notifyDone).toHaveBeenCalledTimes(1);
    await emit(snapshot([failed]));
    expect(current.messages).toEqual([failed]);
    expect(current.providerRecovery).toBeNull();
    expect(setDoneTitle).not.toHaveBeenCalled();
  });

  it.each(["sdk", "ui"])("preserves image-only input when manually retrying an output-limited turn (%s)", async shape => {
    const image = shape === "sdk" ? { type: "image", data: "cG5n", mimeType: "image/png" }
      : { type: "image", source: { type: "base64", media_type: "image/png", data: "cG5n" } };
    const imageUser = { role: "user", content: [image] } as AgentMessage;
    const failed = { ...assistant, stopReason: "length", content: [] } as AgentMessage;
    serverMessages = [imageUser, failed];
    await act(async () => root.render(<Harness selected={session} />));
    const source = FakeEventSource.instances[0];
    await act(async () => { source.open(); source.message(snapshot(serverMessages), "epoch:0"); });
    await act(async () => { await current.handleRetry(); });
    const prompts = harness.send.mock.calls.filter(([, command]) => command.type === "prompt");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toEqual(["one", expect.objectContaining({ message: "", images: [{ type: "image", data: "cG5n", mimeType: "image/png" }] })]);
  });

  it("preserves parallel tools and stop intent across interleaved model messages", async () => {
    await act(async () => root.render(<Harness selected={session} />));
    const emit = (event: AgentEvent) => act(async () => current.handleAgentEventRef.current?.(event));
    await emit(snapshot([], true));
    await emit({ type: "message_start", message: { ...assistant, content: [{ type: "thinking", thinking: "Plan" }] } });
    expect(current.agentPhase?.kind).toBe("thinking");
    await emit({ type: "message_update", message: { ...assistant, content: [{ type: "toolCall", id: "a", name: "read", arguments: { path: "a" } }] } });
    expect(current.agentPhase?.kind).toBe("preparing_tools");
    await emit({ type: "tool_execution_start", toolCallId: "a", toolName: "read" });
    await emit({ type: "tool_execution_start", toolCallId: "b", toolName: "read" });
    await emit({ type: "message_update", message: assistant });
    await emit({ type: "message_end", message: assistant });
    expect(current.agentPhase).toMatchObject({ kind: "running_tools", tools: [{ id: "a" }, { id: "b" }] });
    await emit({ type: "tool_execution_end", toolCallId: "a" });
    expect(current.agentPhase).toMatchObject({ kind: "running_tools", tools: [{ id: "b" }] });
    await emit({ type: "tool_execution_end", toolCallId: "b" });
    await emit({ type: "message_update", message: assistant });
    expect(current.agentPhase?.kind).toBe("writing");
    let finishAbort!: () => void;
    harness.send.mockImplementation((_sid, command) => command.type === "abort" ? new Promise<void>(resolve => { finishAbort = resolve; }) : Promise.resolve(null));
    let abort!: Promise<void>;
    await act(async () => { abort = current.handleAbort(); });
    await emit({ type: "message_update", message: assistant });
    await emit({ type: "tool_execution_start", toolCallId: "late", toolName: "read" });
    expect(current.agentPhase?.kind).toBe("stopping");
    await act(async () => { finishAbort(); await abort; });
    await emit({ type: "agent_end", messages: [{ ...assistant, stopReason: "aborted" }] });
    expect(current.agentPhase).toBeNull();
  });

  it("notifies one live successful completion across rerenders, and stays silent on errors, replay and checkpoints", async () => {
    await act(async () => root.render(<Harness selected={session} />));
    const emit = (event: AgentEvent) => act(async () => current.handleAgentEventRef.current?.(event));
    await emit(snapshot([]));
    await emit({ type: "agent_start" });
    await act(async () => root.render(<Harness selected={{ ...session, name: "renamed" }} />));
    await emit({ type: "agent_end", messages: [assistant] });
    expect(harness.complete).toHaveBeenCalledTimes(1);
    await emit({ type: "agent_end", messages: [assistant] });
    await emit(snapshot([user, assistant]));
    expect(harness.complete).toHaveBeenCalledTimes(1);
    await emit({ type: "agent_start" });
    await emit({ type: "agent_end", messages: [{ ...assistant, stopReason: "error", errorMessage: "failed" }] });
    await emit({ type: "agent_start" });
    await emit({ type: "agent_end", messages: [{ ...assistant, stopReason: "aborted" }] });
    await emit({ type: "agent_start" });
    await emit({ type: "agent_end", messages: [assistant], replayed: true });
    expect(harness.complete).toHaveBeenCalledTimes(1);
  });

  it("decodes the compact REST and SSE tree while preserving context and branch targets", async () => {
    const stored = { ...data([user]), leafId: "e0", tree: [{ entry: { type: "message" as const, id: "e0", parentId: null, timestamp: "2026-10-22T00:00:00Z", message: user }, children: [] }] };
    harness.fetch.mockImplementation(async (url: string) => new Response(JSON.stringify(url.startsWith("/api/sessions/") ? encodeSessionData(stored, "flat-v2") : {})));
    await act(async () => root.render(<Harness selected={session} />));
    expect(current.data?.tree[0].entry.id).toBe("e0");
    const next = { ...stored, leafId: "e1", context: data([user, assistant]).context,
      tree: [{ ...stored.tree[0], children: [{ entry: { type: "message" as const, id: "e1", parentId: "e0", timestamp: "2026-10-22T00:00:01Z", message: assistant }, children: [] }] }] };
    await act(async () => current.handleAgentEventRef.current?.({ ...snapshot([user, assistant]), protocolVersion: 2, sessionData: encodeSessionData(next, "flat-v2") }));
    expect(current.data?.tree[0].children[0].entry.id).toBe("e1");
    expect(current.messages).toEqual([user, assistant]);
    expect(current.data?.leafId).toBe("e1");
  });

  it("renames the current tab without reconnecting, preserves running state and clears the title for New", async () => {
    await act(async () => root.render(<Harness selected={session} />));
    const calls = harness.fetch.mock.calls.length;
    await act(async () => root.render(<Harness selected={{ ...session, name: "Renamed" }} />));
    expect(setIdleTitle).toHaveBeenLastCalledWith("Renamed");
    expect(harness.fetch).toHaveBeenCalledTimes(calls);
    expect(FakeEventSource.instances).toHaveLength(1);
    await act(async () => current.handleAgentEventRef.current?.({ type: "agent_start" }));
    await act(async () => root.render(<Harness selected={{ ...session, name: "Running renamed" }} />));
    expect(setRunningTitle).toHaveBeenLastCalledWith("Running renamed");
    await act(async () => root.render(<Harness key="new" selected={null} />));
    expect(setIdleTitle).toHaveBeenLastCalledWith(undefined);
  });

  it("shows first content immediately and coalesces subsequent updates without delaying completion", async () => {
    await act(async () => root.render(<Harness selected={session} />));
    const update = (text: string) => ({ ...assistant, content: [{ type: "text", text }] }) as AgentMessage;
    await act(async () => current.handleAgentEventRef.current?.({ type: "message_start", message: update("") }));
    await act(async () => current.handleAgentEventRef.current?.({ type: "message_update", message: update("first") }));
    expect(current.streamState.streamingMessage).toMatchObject(update("first"));
    await act(async () => {
      current.handleAgentEventRef.current?.({ type: "message_update", message: update("second") });
      current.handleAgentEventRef.current?.({ type: "message_update", message: update("latest") });
      vi.advanceTimersByTime(15);
    });
    expect(current.streamState.streamingMessage).toMatchObject(update("first"));
    await act(async () => vi.advanceTimersByTime(1));
    expect(current.streamState.streamingMessage).toMatchObject(update("latest"));
    await act(async () => {
      current.handleAgentEventRef.current?.({ type: "message_update", message: update("pending") });
      current.handleAgentEventRef.current?.({ type: "message_end", message: update("complete") });
    });
    expect(current.messages.at(-1)).toMatchObject(update("complete"));
    expect(current.streamState.streamingMessage).toBeNull();
    await act(async () => vi.advanceTimersByTime(100));
    expect(current.streamState.streamingMessage).toBeNull();
  });

  it("flushes pending thinking/tool progress before stop and cancels aborted run frames", async () => {
    await act(async () => root.render(<Harness selected={session} />));
    await act(async () => current.handleAgentEventRef.current?.({ type: "message_start", message: { ...assistant, content: [] } }));
    const thought = { ...assistant, content: [{ type: "thinking", thinking: "reasoning" }] };
    await act(async () => current.handleAgentEventRef.current?.({ type: "message_update", message: thought }));
    expect(current.streamState.streamingMessage).toMatchObject(thought);
    await act(async () => current.handleAgentEventRef.current?.({ type: "message_update", message: { ...assistant, content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "fixture" } }] } }));
    await act(async () => current.handleAbort());
    expect(current.streamState.streamingMessage).toMatchObject({ content: [{ type: "toolCall", toolCallId: "c1", toolName: "read", input: { path: "fixture" } }] });
    await act(async () => {
      current.handleAgentEventRef.current?.({ type: "message_update", message: thought });
      current.handleAgentEventRef.current?.({ type: "agent_end", messages: [] });
    });
    expect(current.streamState.streamingMessage).toBeNull();
    await act(async () => vi.advanceTimersByTime(100));
    expect(current.streamState.streamingMessage).toBeNull();
  });

  it("flushes the latest progress when the tab becomes visible", async () => {
    await act(async () => root.render(<Harness selected={session} />));
    await act(async () => current.handleAgentEventRef.current?.({ type: "message_update", message: assistant }));
    const latest = { ...assistant, content: [{ type: "text", text: "latest hidden progress" }] };
    await act(async () => current.handleAgentEventRef.current?.({ type: "message_update", message: latest }));
    expect(current.streamState.streamingMessage).toMatchObject(assistant);
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(current.streamState.streamingMessage).toMatchObject(latest);
  });

  it("discards pending updates on a snapshot, session replacement and unmount", async () => {
    await act(async () => root.render(<Harness selected={session} />));
    const queue = async () => {
      await act(async () => {
        current.handleAgentEventRef.current?.({ type: "message_start", message: assistant });
        current.handleAgentEventRef.current?.({ type: "message_update", message: { ...assistant, content: [{ type: "text", text: "old pending" }] } });
      });
    };
    await queue();
    await act(async () => current.handleAgentEventRef.current?.(snapshot([user])));
    await act(async () => vi.advanceTimersByTime(100));
    expect(current.streamState.streamingMessage).toBeNull();
    await queue();
    await act(async () => current.handleAgentEventRef.current?.({ type: "session_replaced", previousSessionId: "one", newSessionId: "two" }));
    await act(async () => vi.advanceTimersByTime(100));
    expect(current.streamState.streamingMessage).toMatchObject(assistant);
    await queue();
    const previousHandler = current.handleAgentEventRef.current;
    await act(async () => root.render(<Harness key="new-session" selected={{ ...session, id: "three" }} />));
    await act(async () => {
      previousHandler?.({ type: "message_update", message: assistant });
      vi.advanceTimersByTime(100);
    });
    expect(current.streamState.streamingMessage).toBeNull();
    expect(current.sessionIdRef.current).toBe("three");
  });

  it("retains live generation metrics after authoritative transcript replacement", async () => {
    await act(async () => root.render(<Harness selected={session} />));
    await act(async () => current.handleAgentEventRef.current?.(snapshot([])));
    await act(async () => current.handleAgentEventRef.current?.({ type: "message_start", message: { ...assistant, content: [] } }));
    for (let i = 1; i <= 2; i++) {
      await act(async () => vi.advanceTimersByTime(1000));
      await act(async () => current.handleAgentEventRef.current?.({ type: "message_update", message: { ...assistant, content: [{ type: "text", text: "a".repeat(i * 20) }] } }));
    }
    await act(async () => current.handleAgentEventRef.current?.({ type: "message_end", message: assistant }));
    expect(current.getGenerationMetrics(assistant)).toMatchObject({ seconds: 2, estimated: true });
    await act(async () => current.handleAgentEventRef.current?.(snapshot([user, structuredClone(assistant)])));
    expect(current.getGenerationMetrics(current.messages[1])).toMatchObject({ seconds: 2, estimated: true });
    serverMessages = [user, assistant];
    await act(async () => root.render(<Harness key="reload" selected={session} />));
    expect(current.getGenerationMetrics(current.messages[1])).toMatchObject({ seconds: 2, estimated: true });
    // ChatWindow is keyed by session in AppShell, so switching remounts the hook.
    await act(async () => root.render(<Harness key="two" selected={{ ...session, id: "two" }} />));
    expect(current.getGenerationMetrics(assistant)).toBeUndefined();
  });

  it("browses an existing dw_ session through normal SDK tree navigation", async () => {
    const selected = { ...session, id: "dw_saved-session" };
    serverMessages = [user, assistant];
    await act(async () => root.render(<Harness selected={selected} />));
    await act(async () => { await current.handleNavigate("entry-1"); });
    expect(current.sessionIdRef.current).toBe(selected.id);
    expect(current.activeLeafId).toBe("entry-1");
    expect(current.messages).toEqual([user, assistant]);
    expect(harness.send).toHaveBeenCalledWith(selected.id, { type: "navigate_tree", targetId: "entry-1" });
    expect(harness.fetch).toHaveBeenCalledWith(`/api/sessions/${selected.id}/context?leafId=entry-1`);
    harness.send.mockClear();
    await act(async () => { await harness.branchDataChange.mock.calls.at(-1)![2]("entry-2"); });
    expect(harness.send).toHaveBeenCalledWith(selected.id, { type: "navigate_tree", targetId: "entry-2" });
    expect(harness.fetch).toHaveBeenCalledWith(`/api/sessions/${selected.id}/context?leafId=entry-2`);
  });

  it("reads the accepted thinking level back after changing models", async () => {
    await act(async () => root.render(<Harness selected={session} />));
    harness.fetch.mockResolvedValue(new Response(JSON.stringify({ ...data(), agentState: { running: true, state: { isStreaming: false, thinkingLevel: "low" } } })));
    await act(async () => { await current.handleModelChange("fixture", "reasoning-only"); });
    expect(harness.send).toHaveBeenCalledWith("one", { type: "set_model", provider: "fixture", modelId: "reasoning-only" });
    expect(current.thinkingLevel).toBe("low");
    expect(harness.send.mock.calls.some(([, command]) => command.type === "prompt")).toBe(false);
  });

  it("keeps Plan selected until the server accepts a mode change and retains it on rejection", async () => {
    let accept!: () => void;
    let mode = "plan";
    harness.send.mockImplementation(async (_sid, command) => {
      if (command.type === "get_tools") return { mode, tools: [], selectedNames: [] };
      if (command.type === "set_tools") await new Promise<void>(resolve => { accept = () => { mode = "default"; resolve(); }; });
      return null;
    });
    await act(async () => root.render(<Harness selected={session} />));
    expect(current.toolPreset).toBe("plan");
    let change!: Promise<void>;
    await act(async () => { change = current.handleToolPresetChange("default"); });
    expect(current.toolPreset).toBe("plan");
    await act(async () => { accept(); await change; });
    expect(current.toolPreset).toBe("default");
    expect(harness.send.mock.calls.some(([, command]) => command.type === "prompt")).toBe(false);

    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    harness.send.mockImplementation(async (_sid, command) => {
      if (command.type === "get_tools") return { mode: "plan", tools: [], selectedNames: [] };
      if (command.type === "set_tools") throw new Error("Wait for the current run");
      return null;
    });
    await act(async () => root.render(<Harness key="reopened" selected={session} />));
    await act(async () => { await current.handleToolPresetChange("full"); });
    expect(current.toolPreset).toBe("plan");
    expect(harness.toast).toHaveBeenCalledWith("Could not change tools. Please retry.", { type: "error" });
    log.mockRestore();
  });

  it("ignores a late tool catalog from the session being left", async () => {
    let resolveOld!: (value: unknown) => void;
    harness.send.mockImplementation(async (sid, command) => {
      if (command.type !== "get_tools") return null;
      if (sid === "one") return new Promise(resolve => { resolveOld = resolve; });
      return { mode: "full", tools: [], selectedNames: [] };
    });
    await act(async () => root.render(<Harness selected={session} />));
    await act(async () => root.render(<Harness key="two" selected={{ ...session, id: "two" }} />));
    expect(current.toolPreset).toBe("full");
    await act(async () => resolveOld({ mode: "plan", tools: [], selectedNames: [] }));
    expect(current.toolPreset).toBe("full");
  });

  it("marks the rejected response model, not a different current selection, without a duplicate toast", async () => {
    await act(async () => root.render(<Harness selected={session} />));
    const rejected = { ...assistant, provider: "opencodex", model: "spark", stopReason: "error", errorMessage: "The spark model is not supported when using Codex with a ChatGPT account" };
    serverMessages = [user, rejected];
    await act(async () => current.handleAgentEventRef.current?.({ type: "agent_end", messages: [rejected] }));
    expect(harness.rejectModel).toHaveBeenCalledWith({ provider: "opencodex", modelId: "spark" });
    expect(current.providerRecovery?.kind).toBe("model_unavailable");
    expect(harness.toast).not.toHaveBeenCalled();
    expect(harness.send.mock.calls.some(([, command]) => command.type === "prompt")).toBe(false);
  });

  it("creates only, waits for the snapshot, then receives an instant completed first turn", async () => {
    await act(async () => root.render(<Harness selected={null} />));
    let sending!: Promise<boolean>;
    await act(async () => { sending = current.handleSend("hello"); });
    expect(JSON.parse(harness.fetch.mock.calls[0][1].body)).toMatchObject({ deferPrompt: true, message: "hello" });
    expect(JSON.parse(harness.fetch.mock.calls[0][1].body)).not.toHaveProperty("engine");
    const source = FakeEventSource.instances[0];
    await act(async () => source.open());
    expect(harness.send).not.toHaveBeenCalled();
    harness.send.mockImplementation(async (_sid, command) => {
      if (command.type !== "prompt") return null;
      serverMessages = [user, assistant];
      source.message({ type: "agent_start" }, "epoch:1");
      source.message({ type: "message_end", message: assistant }, "epoch:2");
      source.message({ type: "agent_end", messages: [assistant] }, "epoch:3");
      return null;
    });
    await act(async () => { source.message(snapshot([]), "epoch:0"); await sending; });
    await expect(sending).resolves.toBe(true);
    expect(harness.send).toHaveBeenCalledWith("one", { type: "prompt", message: "hello", timingId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(current.messages).toEqual([user, assistant]);
    expect(current.agentRunning).toBe(false); expect(current.streamState.isStreaming).toBe(false);
    expect(harness.created).toHaveBeenCalledOnce();
  });

  it("does not navigate back when a new-session acknowledgement arrives after switching", async () => {
    await act(async () => root.render(<Harness selected={null} />));
    let finish!: () => void;
    harness.send.mockImplementation((_sid, command) => command.type === "prompt" ? new Promise<void>(resolve => { finish = resolve; }) : Promise.resolve(null));
    let sending!: Promise<boolean>;
    await act(async () => { sending = current.handleSend("belongs to A"); });
    const source = FakeEventSource.instances[0];
    await act(async () => { source.open(); source.message(snapshot([]), "epoch:0"); });
    expect(harness.send.mock.calls.filter(([, command]) => command.type === "prompt")).toHaveLength(1);
    await act(async () => root.render(<Harness selected={{ ...session, id: "B" }} />));
    await act(async () => { finish(); await sending; });
    expect(harness.created).not.toHaveBeenCalled();
    expect(harness.send.mock.calls.filter(([, command]) => command.type === "prompt")).toHaveLength(1);
  });

  it("ends a new-session observation on remount instead of timing its replay as cold output", async () => {
    await act(async () => root.render(<Harness key="new" selected={null} />));
    let sending!: Promise<boolean>;
    await act(async () => { sending = current.handleSend("new session"); });
    const first = FakeEventSource.instances[0];
    await act(async () => { first.open(); first.message(snapshot([]), "epoch:0"); await sending; });
    const timingId = harness.send.mock.calls.find(([, command]) => command.type === "prompt")![1].timingId;
    const record = () => readRunLatencyRecords().find(item => item.timingId === timingId)!;
    expect(record().status).toBe("running");
    serverMessages = [user, assistant];
    serverStreaming = true;
    await act(async () => root.render(<Harness key="created" selected={session} />));
    expect(record().status).toBe("interrupted");
    const next = FakeEventSource.instances.at(-1)!;
    await act(async () => {
      next.open();
      next.message({ type: "connected" }, "");
      next.message({ type: "message_end", message: assistant }, "epoch:2");
      next.message(snapshot([user, assistant]), "epoch:3");
    });
    expect(record().firstContentMs).toBeUndefined();
    expect(record().firstCommitMs).toBeUndefined();
    expect(record().status).toBe("interrupted");
  });

  it("keeps latency running until abort is acknowledged and preserves it when stop fails", async () => {
    await act(async () => root.render(<Harness selected={session} />));
    const source = FakeEventSource.instances[0];
    await act(async () => { source.open(); source.message(snapshot([]), "epoch:0"); });
    await act(async () => { await current.handleSend("still running"); });
    const timingId = harness.send.mock.calls.find(([, command]) => command.type === "prompt")![1].timingId;
    const record = () => readRunLatencyRecords().find(item => item.timingId === timingId)!;
    let rejectAbort!: (reason: Error) => void;
    harness.send.mockImplementation((_sid, command) => command.type === "abort"
      ? new Promise((_resolve, reject) => { rejectAbort = reject; }) : Promise.resolve(null));
    let stopping!: Promise<void>;
    await act(async () => { stopping = current.handleAbort(); });
    expect(record().status).toBe("running");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await act(async () => { rejectAbort(new Error("stop request failed")); await stopping; });
      expect(record().status).toBe("running");
      expect(current.agentPhase).toEqual({ kind: "waiting_model" });
      await act(async () => {
        source.message({ type: "message_end", message: assistant }, "epoch:2");
        source.message({ type: "agent_end", messages: [assistant] }, "epoch:3");
      });
      expect(record()).toMatchObject({ status: "completed", firstContentMs: expect.any(Number), firstCommitMs: expect.any(Number) });
    } finally { error.mockRestore(); }
  });

  it("marks a successful stop aborted only after its command receipt", async () => {
    await act(async () => root.render(<Harness selected={session} />));
    const source = FakeEventSource.instances[0];
    await act(async () => { source.open(); source.message(snapshot([]), "epoch:0"); });
    await act(async () => { await current.handleSend("stop after ack"); });
    const timingId = harness.send.mock.calls.find(([, command]) => command.type === "prompt")![1].timingId;
    const record = () => readRunLatencyRecords().find(item => item.timingId === timingId)!;
    let acknowledge!: () => void;
    harness.send.mockImplementation((_sid, command) => command.type === "abort"
      ? new Promise(resolve => { acknowledge = () => resolve(null); }) : Promise.resolve(null));
    let stopping!: Promise<void>;
    await act(async () => { stopping = current.handleAbort(); });
    expect(record().status).toBe("running");
    await act(async () => { acknowledge(); await stopping; });
    expect(record().status).toBe("aborted");
  });

  it("waits through slow bootstrap and sends only once", async () => {
    await act(async () => root.render(<Harness selected={session} />));
    let sending!: Promise<boolean>;
    await act(async () => { sending = current.handleSend("slow start"); });
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(harness.send.mock.calls.some(([, command]) => command.type === "prompt")).toBe(false);
    await act(async () => { const source = FakeEventSource.instances[0]; source.open(); source.message(snapshot([]), "epoch:0"); await sending; });
    await expect(sending).resolves.toBe(true);
    expect(harness.send.mock.calls.filter(([, command]) => command.type === "prompt")).toHaveLength(1);
  });

  it("cancels a pending start before snapshot and keeps later readiness from posting it", async () => {
    await act(async () => root.render(<Harness selected={session} />));
    let sending!: Promise<boolean>;
    await act(async () => { sending = current.handleSend("cancel this draft"); });
    const timingId = readRunLatencyRecords().at(-1)!.timingId;
    await act(async () => { await current.handleAbort(); await sending; });
    expect(readRunLatencyRecords().find(item => item.timingId === timingId)?.status).toBe("aborted");
    await expect(sending).resolves.toBe(false);
    await act(async () => FakeEventSource.instances[0].message(snapshot([]), "epoch:0"));
    expect(harness.send.mock.calls.some(([, command]) => command.type === "prompt")).toBe(false);
    expect(harness.toast).not.toHaveBeenCalled();
    expect(current.agentRunning).toBe(false);
  });

  it("waits for a dispatched prompt receipt before confirming cancellation", async () => {
    await act(async () => root.render(<Harness selected={session} />));
    await act(async () => FakeEventSource.instances[0].message(snapshot([]), "epoch:0"));
    let acknowledge!: () => void;
    harness.send.mockImplementation((_sid, command) => command.type === "prompt" ? new Promise(resolve => { acknowledge = () => resolve(null); }) : Promise.resolve(null));
    let sending!: Promise<boolean>;
    await act(async () => { sending = current.handleSend("receipt race"); });
    await act(async () => current.handleAbort());
    await act(async () => { acknowledge(); await sending; });
    expect(harness.send.mock.calls.map(([, command]) => command.type).filter(type => type !== "get_tools")).toEqual(["prompt", "abort", "abort"]);
    await expect(sending).resolves.toBe(false);
  });

  it("invalidates latency when a dispatched prompt is cancelled but both stop receipts fail", async () => {
    await act(async () => root.render(<Harness selected={session} />));
    const source = FakeEventSource.instances[0];
    await act(async () => { source.open(); source.message(snapshot([]), "epoch:0"); });
    let acknowledge!: () => void;
    harness.send.mockImplementation((_sid, command) => {
      if (command.type === "prompt") return new Promise(resolve => { acknowledge = () => resolve(null); });
      if (command.type === "abort") return Promise.reject(new Error("stop receipt unavailable"));
      return Promise.resolve(null);
    });
    let sending!: Promise<boolean>;
    await act(async () => { sending = current.handleSend("cancel an unacknowledged prompt"); });
    const timingId = harness.send.mock.calls.find(([, command]) => command.type === "prompt")![1].timingId;
    const record = () => readRunLatencyRecords().find(item => item.timingId === timingId)!;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await act(async () => current.handleAbort());
      expect(record().status).toBe("running");
      await act(async () => { acknowledge(); await sending; });
      await expect(sending).resolves.toBe(false);
      expect(record().status).toBe("interrupted");
    } finally { error.mockRestore(); }
  });

  it("reconciles official SDK queues with stable IDs and image metadata", async () => {
    await act(async () => root.render(<Harness selected={session} />));
    await act(async () => current.handleFollowUp("next", [{ data: "image", mimeType: "image/png", previewUrl: "blob:fixture" }]));
    const id = current.queuedFollowUps[0].id;
    await act(async () => current.handleAgentEventRef.current?.({ type: "queue_update", steering: ["urgent"], followUp: ["next"] }));
    expect(current.queuedFollowUps).toMatchObject([{ message: "urgent", deliveryMode: "steer" }, { id, message: "next", images: [{ data: "image" }] }]);
    await act(async () => current.handleAgentEventRef.current?.({ type: "queue_update", steering: [], followUp: [] }));
    expect(current.queuedFollowUps).toEqual([]);
  });

  it("does not post the prompt if the initial snapshot handshake times out", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => root.render(<Harness selected={null} />));
    let sending!: Promise<boolean>;
    await act(async () => { sending = current.handleSend("hello"); });
    await act(async () => { FakeEventSource.instances[0].open(); await vi.advanceTimersByTimeAsync(30_000); });
    await expect(sending).resolves.toBe(false);
    expect(harness.send).not.toHaveBeenCalled(); expect(harness.created).not.toHaveBeenCalled();
    expect(current.messages).toEqual([]); expect(current.agentRunning).toBe(false);
    vi.restoreAllMocks();
  });

  it("subscribes when mounting an alive idle session and an ephemeral session", async () => {
    await act(async () => root.render(<Harness key="persisted" selected={session} />));
    expect(FakeEventSource.instances).toHaveLength(1);
    await act(async () => root.render(<Harness key="memory" selected={{ ...session, ephemeral: true }} />));
    expect(FakeEventSource.instances).toHaveLength(2);
    await act(async () => { const source = FakeEventSource.instances[1]; source.open(); source.message(snapshot([user, assistant]), "epoch:3"); });
    expect(current.messages).toEqual([user, assistant]); expect(current.agentRunning).toBe(false);
  });

  it("reconciles lost end via snapshot and the online resync even while the wrapper stays alive", async () => {
    serverStreaming = true;
    await act(async () => root.render(<Harness selected={session} />));
    const first = FakeEventSource.instances[0];
    await act(async () => { first.open(); first.message(snapshot([user], true), "epoch:1"); });
    expect(current.agentRunning).toBe(true);
    serverMessages = [user, assistant]; serverStreaming = false;
    await act(async () => window.dispatchEvent(new Event("online")));
    expect(current.agentRunning).toBe(false); expect(current.agentPhase).toBe(null);
    expect(FakeEventSource.instances).toHaveLength(2);
    const resumed = FakeEventSource.instances[1];
    expect(resumed.url).toContain("cursor=epoch%3A1");
    await act(async () => { resumed.open(); resumed.message({ type: "message_end", message: assistant }, "epoch:2"); resumed.message({ type: "agent_end", messages: [assistant] }, "epoch:3"); resumed.message(snapshot([user, assistant]), "epoch:3"); });
    expect(current.messages).toEqual([user, assistant]);
    expect(current.streamState.isStreaming).toBe(false); expect(current.agentStartedAt).toBe(null);
  });

  it("recovers a completed transcript on transport-only reconnect with no online/visibility event", async () => {
    serverStreaming = true;
    await act(async () => root.render(<Harness selected={session} />));
    const first = FakeEventSource.instances[0];
    await act(async () => { first.open(); first.message(snapshot([user], true), "epoch:1"); first.onerror?.(); });
    serverMessages = [user, assistant]; serverStreaming = false;
    await act(async () => vi.advanceTimersByTime(1000));
    const resumed = FakeEventSource.instances[1];
    expect(resumed.url).toContain("cursor=epoch%3A1");
    await act(async () => { resumed.open(); resumed.message({ ...snapshot([user, assistant]), replayStatus: "reset" }, "new-epoch:3"); });
    expect(current.messages).toEqual([user, assistant]);
    expect(current.agentRunning).toBe(false); expect(current.streamState.isStreaming).toBe(false);
  });

  it("restores an immediate model failure from a snapshot after the original event was lost", async () => {
    await act(async () => root.render(<Harness selected={{ ...session, ephemeral: true }} />));
    const source = FakeEventSource.instances[0];
    await act(async () => { source.open(); source.message({ ...snapshot([user]), lastRunError: "No model configured" }, "epoch:1"); });
    expect(current.agentRunning).toBe(false);
    expect(current.providerRecovery?.message).toBe("No model configured");
    expect(current.messages).toEqual([user]);
    expect(current.error).toBe(null);
  });

  it("clears an old failure when an authoritative idle snapshot shows the later run succeeded", async () => {
    await act(async () => root.render(<Harness selected={{ ...session, ephemeral: true }} />));
    await act(async () => current.handleAgentEventRef.current?.({ ...snapshot([user]), lastRunError: "Old model error" }));
    expect(current.providerRecovery?.message).toBe("Old model error");
    await act(async () => current.handleAgentEventRef.current?.({ ...snapshot([user, assistant]), lastRunError: null, replayStatus: "reset" }));
    expect(current.providerRecovery).toBe(null);
    expect(current.agentRunning).toBe(false);
  });

  it("does not resurrect streaming when an obsolete session fetch resolves after an idle snapshot", async () => {
    let resolveLoad!: (response: Response) => void;
    harness.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveLoad = resolve; }));
    await act(async () => root.render(<Harness selected={session} />));
    await act(async () => current.handleAgentEventRef.current?.(snapshot([user, assistant])));
    await act(async () => resolveLoad(new Response(JSON.stringify({ ...data([user]), agentState: { running: true, state: { isStreaming: true } } }))));
    expect(current.messages).toEqual([user, assistant]);
    expect(current.agentRunning).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("clears pending extension UI on session_closed even if its individual close frame was lost", async () => {
    await act(async () => root.render(<Harness selected={{ ...session, ephemeral: true }} />));
    const source = FakeEventSource.instances[0];
    await act(async () => {
      source.open();
      source.message(snapshot([user], true), "epoch:1");
      source.message({ type: "extension_ui_request", id: "question", method: "ask_user", questions: [{ id: "answer", question: "Fixture?", options: [], allowOther: true }] }, "");
      source.message({ type: "extension_ui_request", id: "status", method: "setStatus", statusKey: "review", statusText: "Waiting" }, "");
    });
    expect(current.extensionUIState.dialogs).toHaveLength(1);
    await act(async () => source.message({ type: "session_closed", sessionId: "one" }, "epoch:2"));
    expect(current.extensionUIState).toEqual({ dialogs: [], statuses: {}, widgets: {} });
    expect(current.agentRunning).toBe(false);
    expect(current.streamState.isStreaming).toBe(false);
    expect(source.readyState).toBe(FakeEventSource.CLOSED);
  });

  it("applies a recovered replacement identity before its snapshot and ignores older sequence frames afterward", async () => {
    await act(async () => root.render(<Harness selected={{ ...session, ephemeral: true }} />));
    const source = FakeEventSource.instances[0];
    await act(async () => {
      source.open();
      source.message(snapshot([user], true), "epoch:1");
      source.message({ type: "session_replaced", previousSessionId: "one", newSessionId: "next", cwd: "/fixture/next" }, "");
      source.message({ ...snapshot([user, assistant]), sessionId: "next", sessionData: { ...data([user, assistant]), sessionId: "next" } }, "epoch:9");
      source.message({ type: "message_end", message: { ...assistant, content: [{ type: "text", text: "stale previous session" }] } }, "epoch:3");
      source.message({ type: "agent_start" }, "epoch:4");
    });
    expect(current.sessionIdRef.current).toBe("next");
    expect(current.messages).toEqual([user, assistant]);
    expect(current.agentRunning).toBe(false);
    expect(current.data?.sessionId).toBe("next");
  });
});
