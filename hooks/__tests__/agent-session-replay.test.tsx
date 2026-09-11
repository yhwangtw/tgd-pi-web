// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo, AgentMessage } from "@/lib/types";
import type { AgentEvent, SessionData } from "../use-agent-session-types";

const harness = vi.hoisted(() => ({ send: vi.fn(), toast: vi.fn(), created: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/agent-client", () => ({ sendAgentCommand: harness.send }));
vi.mock("@/hooks/useToast", () => ({ showToast: harness.toast }));
vi.mock("@/lib/attention", () => ({ setIdleTitle: vi.fn(), setRunningTitle: vi.fn(), setDoneTitle: vi.fn(), setErrorTitle: vi.fn(), setExtensionTitle: vi.fn(), notifyDone: vi.fn(), requestNotifyPermission: vi.fn() }));
vi.mock("../use-model-catalog", () => ({ useModelCatalog: () => ({ modelNames: {}, modelList: [], modelThinkingLevels: {}, modelThinkingLevelMaps: {}, newSessionModel: { provider: "fixture", modelId: "instant" }, setNewSessionModel: vi.fn(), catalogStatus: "ready", catalogDiagnostics: [], retryModelCatalog: vi.fn() }) }));
import { useAgentSession } from "../useAgentSession";

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
    const value = useAgentSession({ session: selected, newSessionCwd: selected ? null : "/fixture", onSessionCreated: harness.created });
    useEffect(() => { current = value; }, [value]);
    return null;
  }
  beforeEach(() => {
    vi.useFakeTimers(); vi.stubGlobal("EventSource", FakeEventSource); vi.stubGlobal("fetch", harness.fetch);
    FakeEventSource.instances = []; serverMessages = []; serverStreaming = false;
    harness.send.mockReset(); harness.created.mockReset(); harness.toast.mockReset(); harness.fetch.mockReset();
    harness.send.mockResolvedValue(null);
    harness.fetch.mockImplementation(async (url: string) => {
      if (url === "/api/agent/new") return new Response(JSON.stringify({ sessionId: "one", deferred: true }));
      if (url.startsWith("/api/sessions/")) return new Response(JSON.stringify({ ...data(serverMessages), agentState: { running: true, state: { isStreaming: serverStreaming } } }));
      return new Response("{}");
    });
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("creates only, waits for the snapshot, then receives an instant completed first turn", async () => {
    await act(async () => root.render(<Harness selected={null} />));
    let sending!: Promise<boolean>;
    await act(async () => { sending = current.handleSend("hello"); });
    expect(JSON.parse(harness.fetch.mock.calls[0][1].body)).toMatchObject({ deferPrompt: true, message: "hello" });
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
    expect(harness.send).toHaveBeenCalledWith("one", { type: "prompt", message: "hello" });
    expect(current.messages).toEqual([user, assistant]);
    expect(current.agentRunning).toBe(false); expect(current.streamState.isStreaming).toBe(false);
    expect(harness.created).toHaveBeenCalledOnce();
  });

  it("does not post the prompt if the initial snapshot handshake times out", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => root.render(<Harness selected={null} />));
    let sending!: Promise<boolean>;
    await act(async () => { sending = current.handleSend("hello"); });
    await act(async () => { FakeEventSource.instances[0].open(); await vi.advanceTimersByTimeAsync(1500); });
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
