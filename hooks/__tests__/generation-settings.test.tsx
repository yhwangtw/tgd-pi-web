// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage, SessionInfo } from "@/lib/types";
import type { GenerationSelection, GenerationSettingsState } from "@/lib/generation-settings";
import type { AgentEvent, ChatInputHandle, SessionData } from "@/hooks/use-agent-session-types";

const harness = vi.hoisted(() => ({
  send: vi.fn(), fetch: vi.fn(), toast: vi.fn(), created: vi.fn(), setNewModel: vi.fn(),
}));
vi.mock("@/lib/agent-client", () => ({ sendAgentCommand: harness.send }));
vi.mock("@/hooks/useToast", () => ({ showToast: harness.toast }));
vi.mock("@/lib/attention", () => ({
  setIdleTitle: vi.fn(), setRunningTitle: vi.fn(), setDoneTitle: vi.fn(), setStoppedTitle: vi.fn(),
  setErrorTitle: vi.fn(), setExtensionTitle: vi.fn(), notifyDone: vi.fn(), requestNotifyPermission: vi.fn(),
}));
vi.mock("@/hooks/use-model-catalog", async () => {
  const { useState } = await import("react");
  return {
    useModelCatalog: () => {
      const [model, setModel] = useState({ provider: "fixture", modelId: "original" });
      return {
        modelNames: {},
        modelList: [
          { provider: "fixture", id: "original", name: "Original" },
          { provider: "fixture", id: "alternate", name: "Alternate" },
          { provider: "fixture", id: "rejected", name: "Rejected", available: false },
        ],
        modelThinkingLevels: {}, modelThinkingLevelMaps: {},
        newSessionModel: model,
        setNewSessionModel: (value: { provider: string; modelId: string }) => {
          harness.setNewModel(value);
          setModel(value);
        },
        catalogStatus: "ready", catalogDiagnostics: [], retryModelCatalog: vi.fn(), reportModelUnavailable: vi.fn(),
      };
    },
  };
});
import { useAgentSession } from "@/hooks/useAgentSession";

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
  message(event: AgentEvent, id = "settings:0") {
    this.onmessage?.({ data: JSON.stringify(event), lastEventId: id });
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

const session: SessionInfo = {
  id: "one", path: "", cwd: "/fixture", name: "Fixture", created: "", modified: "", messageCount: 0, firstMessage: "",
};
const history: AgentMessage[] = [
  { role: "user", content: "Keep working", timestamp: 1 },
  { role: "assistant", provider: "fixture", model: "original", content: [{ type: "text", text: "Saved progress" }], stopReason: "aborted", timestamp: 2 },
];
const selection = (modelId = "original", thinkingLevel = "high"): GenerationSelection => ({
  provider: "fixture", modelId, thinkingLevel,
});
function settings(overrides: Partial<GenerationSettingsState> = {}): GenerationSettingsState {
  return {
    selected: selection(), active: selection(), revision: 1, pending: false,
    restarting: false, runId: "run-one", canRestart: false, ...overrides,
  };
}
function data(sid = "one"): SessionData {
  return {
    sessionId: sid, filePath: "", tree: [], leafId: "saved-leaf",
    context: { messages: history, entryIds: ["e0", "e1"], model: { provider: "fixture", modelId: "original" }, thinkingLevel: "high" },
  };
}
function snapshot(value: GenerationSettingsState, sid = "one"): AgentEvent {
  return {
    type: "session_snapshot", sessionId: sid, sessionData: data(sid), streamingMessage: null,
    state: {
      isStreaming: true, generationSettings: value,
      runState: { id: value.runId ?? "run-one", startedAt: 100, lastProgressAt: 100, observedAt: 100, phase: { kind: "thinking" } },
    },
  };
}

describe("live generation settings", () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: ReturnType<typeof useAgentSession>;
  let input: ChatInputHandle;
  let inputRef: { current: ChatInputHandle };
  let serverSettings: Map<string, GenerationSettingsState>;

  function Harness({ selected = session, scopeCwd }: { selected?: SessionInfo | null; scopeCwd?: string | null }) {
    const value = useAgentSession({
      session: selected,
      newSessionCwd: scopeCwd === undefined ? selected ? null : "/fixture" : scopeCwd,
      onSessionCreated: harness.created,
      chatInputRef: inputRef,
    });
    useEffect(() => { current = value; }, [value]);
    return null;
  }

  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", harness.fetch);
    FakeEventSource.instances = [];
    serverSettings = new Map([["one", settings()], ["two", settings({ selected: selection("alternate", "low"), runId: "run-two" })]]);
    for (const mock of Object.values(harness)) mock.mockReset();
    harness.send.mockResolvedValue(null);
    harness.fetch.mockImplementation(async (url: string) => {
      const match = /^\/api\/sessions\/([^/?]+)/.exec(url);
      if (match) {
        const sid = decodeURIComponent(match[1]);
        const value = serverSettings.get(sid)!;
        return new Response(JSON.stringify({
          ...data(sid), agentState: { running: true, state: { isStreaming: true, generationSettings: value } },
        }));
      }
      return new Response("{}");
    });
    input = { insertText: vi.fn(), insertIfEmpty: vi.fn(), setText: vi.fn(), addImages: vi.fn() };
    inputRef = { current: input };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const render = async (node = <Harness />) => { await act(async () => root.render(node)); };
  const emit = async (event: AgentEvent) => { await act(async () => current.handleAgentEventRef.current?.(event)); };
  const commands = () => harness.send.mock.calls.filter(([, command]) => command.type !== "get_tools");
  const pending = () => settings({
    revision: 2, selected: selection("alternate", "low"), pending: true, canRestart: true,
  });
  async function ready(value = pending()) {
    await render();
    await act(async () => {
      const source = FakeEventSource.instances.at(-1)!;
      source.open();
      source.message(snapshot(value));
    });
    harness.send.mockClear();
  }
  function expectDraftAndHistoryPreserved() {
    expect(current.messages).toEqual(history);
    expect(current.entryIds).toEqual(["e0", "e1"]);
    expect(current.activeLeafId).toBe("saved-leaf");
    expect(localStorage.getItem("pi-draft:one")).toBe("Unsaved local draft");
    for (const method of Object.values(input)) expect(method).not.toHaveBeenCalled();
    expect(commands().some(([, command]) => ["prompt", "steer", "follow_up", "navigate_tree"].includes(command.type))).toBe(false);
  }

  it("sends a model configuration during generation without stopping or replaying the user message", async () => {
    await render();
    expect(current.agentRunning).toBe(true);
    const accepted = pending();
    harness.send.mockResolvedValueOnce(accepted);
    await act(async () => { expect(await current.handleModelChange("fixture", "alternate")).toBe(true); });
    expect(commands()).toEqual([["one", { type: "configure_generation", model: { provider: "fixture", modelId: "alternate" } }]]);
    expect(current.generationSettings).toEqual(accepted);
    expect(current.currentModel).toEqual({ provider: "fixture", modelId: "alternate" });
    expect(current.thinkingLevel).toBe("low");
    expect(current.generationSettings?.active).toEqual(selection());
    expect(current.agentRunning).toBe(true);
    expect(current.messages).toEqual(history);
  });

  it.each([
    ["auto", "off"],
    ["max", "high"],
  ] as const)("sends %s and displays the server-accepted %s reasoning level", async (requested, acceptedLevel) => {
    await render();
    const accepted = pending();
    accepted.selected = selection("original", acceptedLevel);
    harness.send.mockResolvedValueOnce(accepted);
    await act(async () => current.handleThinkingLevelChange(requested));
    expect(commands()).toEqual([["one", { type: "configure_generation", thinkingLevel: requested }]]);
    expect(current.thinkingLevel).toBe(acceptedLevel);
    expect(current.generationSettings).toEqual(accepted);
    expect(current.agentRunning).toBe(true);
  });

  it("rejects unavailable models before sending a command", async () => {
    await render();
    harness.send.mockClear();
    await act(async () => { expect(await current.handleModelChange("fixture", "rejected")).toBe(false); });
    expect(commands()).toHaveLength(0);
    expect(current.generationSettings).toEqual(settings());
  });

  it("sets a synchronous operation guard before React rerenders and unlocks after the receipt", async () => {
    await render();
    const receipt = deferred<GenerationSettingsState>();
    harness.send.mockImplementation((_sid, command) => command.type === "configure_generation" ? receipt.promise : Promise.resolve(null));
    let first!: Promise<boolean>;
    await act(async () => {
      first = current.handleModelChange("fixture", "alternate");
      expect(await current.handleModelChange("fixture", "original")).toBe(false);
      await current.handleThinkingLevelChange("auto");
    });
    expect(commands()).toHaveLength(1);
    expect(current.settingsUpdating).toBe(true);
    await act(async () => { receipt.resolve(pending()); expect(await first).toBe(true); });
    expect(current.settingsUpdating).toBe(false);
    harness.send.mockResolvedValueOnce(settings({ revision: 3, selected: selection("alternate", "off") }));
    await act(async () => current.handleThinkingLevelChange("off"));
    expect(commands()).toHaveLength(2);
  });

  it("does not let an old view scope receipt clear a newer operation in the same hook", async () => {
    await render(<Harness scopeCwd="/scope-a" />);
    const oldReceipt = deferred<GenerationSettingsState>();
    const newReceipt = deferred<GenerationSettingsState>();
    harness.send.mockImplementationOnce(() => oldReceipt.promise);
    let oldChange!: Promise<boolean>;
    await act(async () => { oldChange = current.handleModelChange("fixture", "alternate"); });
    await render(<Harness scopeCwd="/scope-b" />);
    await emit({ type: "generation_settings_changed", settings: settings({ revision: 10 }) });
    harness.send.mockImplementationOnce(() => newReceipt.promise);
    let newChange!: Promise<void>;
    await act(async () => { newChange = current.handleThinkingLevelChange("low"); });
    await act(async () => {
      oldReceipt.resolve(pending());
      expect(await oldChange).toBe(false);
    });
    expect(current.settingsUpdating).toBe(true);
    expect(current.generationSettings?.revision).toBe(10);
    const accepted = settings({ revision: 11, selected: selection("original", "low") });
    await act(async () => { newReceipt.resolve(accepted); await newChange; });
    expect(current.generationSettings).toEqual(accepted);
    expect(current.settingsUpdating).toBe(false);
  });

  it.each(["accepted", "failed"] as const)("keeps a stale %s command from altering another mounted session", async outcome => {
    await render(<Harness key="one" />);
    const receipt = deferred<GenerationSettingsState>();
    harness.send.mockImplementationOnce(() => receipt.promise);
    let change!: Promise<boolean>;
    await act(async () => { change = current.handleModelChange("fixture", "alternate"); });
    const other = { ...session, id: "two" };
    await render(<Harness key="two" selected={other} />);
    const expected = serverSettings.get("two");
    await act(async () => {
      if (outcome === "accepted") receipt.resolve(pending());
      else receipt.reject(new Error("Old session request failed"));
      expect(await change).toBe(false);
    });
    expect(current.generationSettings).toEqual(expected);
    expect(current.currentModel).toEqual({ provider: "fixture", modelId: "alternate" });
    expect(current.thinkingLevel).toBe("low");
    expect(current.settingsUpdating).toBe(false);
    expect(harness.toast).not.toHaveBeenCalled();
  });

  it.each(["event", "snapshot"] as const)("keeps newer active/pending SSE state when an equal-revision HTTP receipt arrives (%s)", async source => {
    await render();
    const receipt = deferred<GenerationSettingsState>();
    harness.send.mockImplementationOnce(() => receipt.promise);
    let change!: Promise<boolean>;
    await act(async () => { change = current.handleModelChange("fixture", "alternate"); });
    const active = pending();
    active.active = active.selected;
    active.pending = false;
    active.canRestart = false;
    await emit(source === "event" ? { type: "generation_settings_changed", settings: active } : snapshot(active));
    await act(async () => { receipt.resolve(pending()); expect(await change).toBe(true); });
    expect(current.generationSettings).toEqual(active);
    expect(current.generationSettings?.pending).toBe(false);
    expect(current.settingsUpdating).toBe(false);
  });

  it("keeps newer SSE settings when a delayed session GET has the same revision", async () => {
    const response = deferred<Response>();
    harness.fetch.mockImplementationOnce(() => response.promise);
    await render();
    const active = pending();
    active.active = active.selected;
    active.pending = false;
    await emit(snapshot(active));
    await act(async () => response.resolve(new Response(JSON.stringify({
      ...data(), agentState: { running: true, state: { isStreaming: true, generationSettings: pending() } },
    }))));
    expect(current.generationSettings).toEqual(active);
    expect(current.currentModel).toEqual({ provider: "fixture", modelId: "alternate" });
    expect(current.thinkingLevel).toBe("low");
  });

  it("applies once with the observed run/revision and preserves drafts, transcript and branch", async () => {
    localStorage.setItem("pi-draft:one", "Unsaved local draft");
    await ready();
    const receipt = deferred<{ accepted: boolean }>();
    harness.send.mockImplementation((_sid, command) => command.type === "resume" ? receipt.promise : Promise.resolve(null));
    let restart!: Promise<boolean>;
    await act(async () => {
      restart = current.handleApplySettingsNow();
      expect(await current.handleApplySettingsNow()).toBe(false);
    });
    expect(current.settingsUpdating).toBe(true);
    expect(current.settingsRestarting).toBe(true);
    expect(commands()).toEqual([["one", {
      type: "resume", timingId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      stopCurrentRun: true, expectedRunId: "run-one", expectedSettingsRevision: 2,
    }]]);
    expectDraftAndHistoryPreserved();
    await act(async () => { receipt.resolve({ accepted: true }); expect(await restart).toBe(true); });
    expect(current.settingsUpdating).toBe(false);
    expect(current.settingsRestarting).toBe(false);
    expectDraftAndHistoryPreserved();
  });

  it("repeats Stop after a delayed apply receipt so late admission cannot escape cancellation", async () => {
    localStorage.setItem("pi-draft:one", "Unsaved local draft");
    await ready();
    const receipt = deferred<{ accepted: boolean }>();
    harness.send.mockImplementation((_sid, command) => command.type === "resume" ? receipt.promise : Promise.resolve(null));
    let restart!: Promise<boolean>;
    await act(async () => { restart = current.handleApplySettingsNow(); });
    await act(async () => current.handleAbort());
    await act(async () => { receipt.resolve({ accepted: true }); expect(await restart).toBe(false); });
    expect(commands().map(([, command]) => command.type)).toEqual(["resume", "abort", "abort"]);
    expect(current.settingsUpdating).toBe(false);
    expect(current.settingsRestarting).toBe(false);
    expect(current.agentRunning).toBe(false);
    expect(harness.toast).not.toHaveBeenCalled();
    expectDraftAndHistoryPreserved();
  });

  it("keeps new-session model and reasoning choices local before a runtime exists", async () => {
    await render(<Harness selected={null} />);
    await act(async () => { expect(await current.handleModelChange("fixture", "alternate")).toBe(true); });
    await act(async () => current.handleThinkingLevelChange("high"));
    expect(current.displayModel).toEqual({ provider: "fixture", modelId: "alternate" });
    expect(current.thinkingLevel).toBe("high");
    await act(async () => current.handleThinkingLevelChange("auto"));
    expect(current.thinkingLevel).toBe("auto");
    expect(harness.setNewModel).toHaveBeenCalledExactlyOnceWith({ provider: "fixture", modelId: "alternate" });
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.fetch).not.toHaveBeenCalled();
    expect(current.settingsUpdating).toBe(false);
  });
});
