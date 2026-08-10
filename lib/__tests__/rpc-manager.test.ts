import { describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { AgentSessionWrapper } from "../rpc-manager";
import type { AgentSessionLike } from "../pi-types";
import { WebExtensionUIBridge } from "../web-extension-ui";

describe("AgentSessionWrapper prompt command", () => {
  it("lets background callers observe an immediate prompt rejection", async () => {
    const failure = new Error("No model configured");
    const inner = {
      sessionId: "session-background",
      sessionFile: "/tmp/session-background.jsonl",
      prompt: vi.fn().mockRejectedValue(failure),
      dispose: vi.fn(),
    } as unknown as AgentSessionLike;
    const wrapper = new AgentSessionWrapper(inner);
    try {
      await expect(wrapper.send({
        type: "prompt",
        message: "scheduled task",
        awaitCompletion: true,
      })).rejects.toThrow("No model configured");
    } finally {
      wrapper.destroy();
    }
  });

  it("preserves fire-and-forget behavior for interactive browser prompts", async () => {
    const inner = {
      sessionId: "session-browser",
      sessionFile: "/tmp/session-browser.jsonl",
      prompt: vi.fn().mockRejectedValue(new Error("reported over events")),
      dispose: vi.fn(),
    } as unknown as AgentSessionLike;
    const wrapper = new AgentSessionWrapper(inner);
    try {
      await expect(wrapper.send({ type: "prompt", message: "interactive" })).resolves.toBeNull();
    } finally {
      wrapper.destroy();
    }
  });
});

describe("AgentSessionWrapper compact command", () => {
  it("delegates repeated-compaction eligibility to Pi", async () => {
    const compactResult = {
      summary: "updated summary",
      firstKeptEntryId: "kept-2",
      tokensBefore: 42_000,
      estimatedTokensAfter: 12_000,
    };
    const compact = vi.fn().mockResolvedValue(compactResult);
    const inner = {
      sessionId: "session-1",
      sessionFile: "/tmp/session-1.jsonl",
      sessionManager: {
        // The old web pre-check rejects this shape before Pi gets a chance to
        // apply its firstKeptEntryId-aware repeated-compaction logic.
        getBranch: () => [
          {
            type: "compaction",
            id: "compact-1",
            firstKeptEntryId: "kept-1",
          },
          { type: "message", id: "new-user", message: { role: "user", content: "continue" } },
        ],
      },
      settingsManager: {
        getCompactionSettings: () => ({ enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 }),
      },
      compact,
      dispose: vi.fn(),
    } as unknown as AgentSessionLike;
    const wrapper = new AgentSessionWrapper(inner);

    try {
      await expect(wrapper.send({ type: "compact", customInstructions: "focus on decisions" }))
        .resolves.toEqual(compactResult);
      expect(compact).toHaveBeenCalledWith("focus on decisions");
    } finally {
      wrapper.destroy();
    }
  });
});

describe("AgentSessionWrapper model catalog refresh", () => {
  it("refreshes persisted auth and models before resolving a model change", async () => {
    const model = { id: "gpt-5.6-luna", provider: "openai-codex" };
    let refreshed = false;
    const find = vi.fn(() => refreshed ? model : undefined);
    const setModel = vi.fn().mockResolvedValue(undefined);
    const inner = {
      sessionId: "session-1",
      sessionFile: "/tmp/session-1.jsonl",
      setModel,
      dispose: vi.fn(),
    } as unknown as AgentSessionLike;
    const refreshModels = vi.fn(async () => { refreshed = true; });
    const wrapper = new AgentSessionWrapper(
      inner,
      "",
      undefined,
      [],
      refreshModels,
      undefined,
      { find } as never,
    );

    try {
      await expect(wrapper.send({
        type: "set_model",
        provider: "openai-codex",
        modelId: "gpt-5.6-luna",
      })).resolves.toEqual(model);
      expect(refreshModels).toHaveBeenCalledOnce();
      expect(find).toHaveBeenCalledWith("openai-codex", "gpt-5.6-luna");
      expect(setModel).toHaveBeenCalledWith(model);
    } finally {
      wrapper.destroy();
    }
  });
});

describe("AgentSessionWrapper authentication refresh", () => {
  it("restarts an idle session after notifying connected clients", () => {
    const dispose = vi.fn();
    const inner = {
      sessionId: "session-idle",
      sessionFile: "/tmp/session-idle.jsonl",
      isStreaming: false,
      isCompacting: false,
      subscribe: vi.fn(() => vi.fn()),
      dispose,
    } as unknown as AgentSessionLike;
    const wrapper = new AgentSessionWrapper(inner);
    const events: Array<{ type: string }> = [];
    wrapper.start();
    wrapper.onEvent((event) => events.push(event));

    expect(wrapper.requestAuthRefresh()).toBe("restarted");
    expect(events).toContainEqual({ type: "session_restart", reason: "auth" });
    expect(wrapper.isAlive()).toBe(false);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("defers restart until a streaming run becomes idle", async () => {
    let streaming = true;
    let emit: ((event: { type: string }) => void) | undefined;
    const dispose = vi.fn();
    const inner = {
      sessionId: "session-running",
      sessionFile: "/tmp/session-running.jsonl",
      get isStreaming() { return streaming; },
      isCompacting: false,
      subscribe: vi.fn((listener: (event: { type: string }) => void) => {
        emit = listener;
        return vi.fn();
      }),
      dispose,
    } as unknown as AgentSessionLike;
    const wrapper = new AgentSessionWrapper(inner);
    const events: Array<{ type: string }> = [];
    wrapper.start();
    wrapper.onEvent((event) => events.push(event));

    expect(wrapper.requestAuthRefresh()).toBe("deferred");
    expect(wrapper.requestAuthRefresh()).toBe("deferred");
    expect(events).toContainEqual({ type: "session_restart_deferred", reason: "auth" });
    expect(events.filter((event) => event.type === "session_restart_deferred")).toHaveLength(1);
    expect(wrapper.isAlive()).toBe(true);

    streaming = false;
    emit?.({ type: "agent_end" });
    await Promise.resolve();

    expect(events).toContainEqual({ type: "session_restart", reason: "auth" });
    expect(wrapper.isAlive()).toBe(false);
    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe("AgentSessionWrapper extension lifecycle", () => {
  it("replays pending Web UI requests and accepts a typed response", async () => {
    const bridge = new WebExtensionUIBridge({ theme: {} as never });
    const inner = {
      sessionId: "session-ui",
      sessionFile: "/tmp/session-ui.jsonl",
      dispose: vi.fn(),
    } as unknown as AgentSessionLike;
    const wrapper = new AgentSessionWrapper(inner, "", undefined, [], undefined, bridge);
    const answerPromise = bridge.select("Pick a target", ["A", "B"]);
    const events: Array<{ type: string; id?: string; method?: string }> = [];

    const unsubscribe = wrapper.onEvent((event) => events.push(event));
    const request = events.find((event) => event.method === "select");
    expect(request).toBeDefined();
    await expect(wrapper.send({
      type: "extension_ui_response",
      id: request!.id,
      value: "B",
    })).resolves.toEqual({ accepted: true });
    await expect(answerPromise).resolves.toBe("B");
    expect(events.at(-1)).toMatchObject({ type: "extension_ui_closed", id: request!.id });

    unsubscribe();
    wrapper.destroy();
  });

  it("keeps ask_user active in non-empty tool presets and cancels questions on destroy", async () => {
    const setActiveToolsByName = vi.fn();
    const bridge = new WebExtensionUIBridge({ theme: {} as never });
    const inner = {
      sessionId: "session-ui",
      sessionFile: "/tmp/session-ui.jsonl",
      setActiveToolsByName,
      dispose: vi.fn(),
    } as unknown as AgentSessionLike;
    const wrapper = new AgentSessionWrapper(inner, "", undefined, [], undefined, bridge);

    await wrapper.send({ type: "set_tools", toolNames: ["read", "edit"] });
    expect(setActiveToolsByName).toHaveBeenCalledWith(["read", "edit", "ask_user"]);

    const answerPromise = bridge.input("Release note");
    wrapper.destroy();
    await expect(answerPromise).resolves.toBeUndefined();
  });

  it("does not replay setEditorText after it was delivered live", () => {
    const bridge = new WebExtensionUIBridge({ theme: {} as never });
    const inner = {
      sessionId: "session-ui",
      sessionFile: "/tmp/session-ui.jsonl",
      dispose: vi.fn(),
    } as unknown as AgentSessionLike;
    const wrapper = new AgentSessionWrapper(inner, "", undefined, [], undefined, bridge);
    const firstEvents: Array<{ type: string; method?: string }> = [];
    const unsubscribe = wrapper.onEvent((event) => firstEvents.push(event));

    bridge.setEditorText("prefill once");
    expect(firstEvents).toEqual(expect.arrayContaining([expect.objectContaining({ method: "set_editor_text" })]));
    unsubscribe();

    const reconnectEvents: Array<{ type: string; method?: string }> = [];
    wrapper.onEvent((event) => reconnectEvents.push(event));
    expect(reconnectEvents).not.toEqual(expect.arrayContaining([expect.objectContaining({ method: "set_editor_text" })]));
    wrapper.destroy();
  });

  it("emits session_shutdown before disposing the session", async () => {
    const calls: string[] = [];
    const emit = vi.fn(async (event: { type: string; reason: string }) => {
      calls.push(`${event.type}:${event.reason}`);
      return [];
    });
    const inner = {
      sessionId: "session-1",
      sessionFile: "/tmp/session-1.jsonl",
      extensionRunner: { emit },
      dispose: vi.fn(() => calls.push("dispose")),
    } as unknown as AgentSessionLike;
    const wrapper = new AgentSessionWrapper(inner);

    await wrapper.shutdown("reload");

    expect(emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "reload" });
    expect(calls).toEqual(["session_shutdown:reload", "dispose"]);
    expect(wrapper.isAlive()).toBe(false);
  });

  it("reloads extensions only while the session is idle", async () => {
    const reload = vi.fn().mockResolvedValue(undefined);
    const busyInner = {
      sessionId: "session-busy",
      sessionFile: "/tmp/session-busy.jsonl",
      isStreaming: true,
      isCompacting: false,
      reload,
      dispose: vi.fn(),
    } as unknown as AgentSessionLike;
    const idleInner = {
      ...busyInner,
      sessionId: "session-idle",
      isStreaming: false,
    } as unknown as AgentSessionLike;

    const busy = new AgentSessionWrapper(busyInner);
    const idle = new AgentSessionWrapper(idleInner);
    try {
      await expect(busy.reloadExtensions()).rejects.toThrow("idle");
      await expect(idle.reloadExtensions()).resolves.toBeUndefined();
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      busy.destroy();
      idle.destroy();
    }
  });

  it("rebinds subscriptions and extension UI after the runtime replaces a session", async () => {
    const oldUnsubscribe = vi.fn();
    const nextUnsubscribe = vi.fn();
    let nextEventListener: ((event: { type: string }) => void) | undefined;
    const oldInner = {
      sessionId: "session-old",
      sessionFile: "/tmp/session-old.jsonl",
      subscribe: vi.fn(() => oldUnsubscribe),
      sessionManager: { appendCustomEntry: vi.fn() },
      dispose: vi.fn(),
    } as unknown as AgentSessionLike;
    const nextInner = {
      sessionId: "session-next",
      sessionFile: "/tmp/session-next.jsonl",
      subscribe: vi.fn((listener: (event: { type: string }) => void) => {
        nextEventListener = listener;
        return nextUnsubscribe;
      }),
      bindExtensions: vi.fn().mockResolvedValue(undefined),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
      navigateTree: vi.fn().mockResolvedValue({ cancelled: false }),
      reload: vi.fn().mockResolvedValue(undefined),
      sessionManager: { appendCustomEntry: vi.fn() },
      dispose: vi.fn(),
    } as unknown as AgentSessionLike;
    let activeInner = oldInner;
    let beforeSessionInvalidate: (() => void) | undefined;
    let rebindSession: (() => Promise<void>) | undefined;
    const runtime = {
      get session() { return activeInner; },
      get cwd() { return activeInner === oldInner ? "/work/old" : "/work/next"; },
      setBeforeSessionInvalidate: vi.fn((callback?: () => void) => { beforeSessionInvalidate = callback; }),
      setRebindSession: vi.fn((callback?: () => Promise<void>) => { rebindSession = callback; }),
      dispose: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentSessionRuntime;
    const bridge = new WebExtensionUIBridge({ theme: {} as never });
    const onSessionReplaced = vi.fn();
    const wrapper = new AgentSessionWrapper(oldInner, "/work/old", undefined, [], undefined, bridge);
    wrapper.attachRuntime(runtime, () => undefined, onSessionReplaced);
    wrapper.start();
    const events: Array<{ type: string; newSessionId?: string }> = [];
    wrapper.onEvent((event) => events.push(event));

    beforeSessionInvalidate?.();
    activeInner = nextInner;
    await rebindSession?.();
    nextEventListener?.({ type: "agent_start" });

    expect(oldUnsubscribe).toHaveBeenCalledOnce();
    expect(wrapper.inner).toBe(nextInner);
    expect(wrapper.cwd).toBe("/work/next");
    expect(nextInner.bindExtensions).toHaveBeenCalledOnce();
    expect(onSessionReplaced).toHaveBeenCalledWith(wrapper, "session-old", "session-next");
    // Rebind precedes withSession. The public replacement event is emitted by
    // the enclosing runtime operation only after withSession succeeds.
    expect(events).not.toContainEqual(expect.objectContaining({ type: "session_replaced" }));
    expect(events).toContainEqual({ type: "agent_start" });

    wrapper.destroy();
    expect(nextUnsubscribe).toHaveBeenCalledOnce();
    expect(runtime.dispose).toHaveBeenCalledOnce();
  });

  it("recreates the previous runtime when replacement fails after invalidation", async () => {
    const oldUnsubscribe = vi.fn();
    const recoveredUnsubscribe = vi.fn();
    const oldInner = {
      sessionId: "session-old",
      sessionFile: "/tmp/session-old.jsonl",
      subscribe: vi.fn(() => oldUnsubscribe),
      sessionManager: { appendCustomEntry: vi.fn() },
      dispose: vi.fn(),
    } as unknown as AgentSessionLike;
    const recoveredInner = {
      sessionId: "session-old",
      sessionFile: "/tmp/session-old.jsonl",
      subscribe: vi.fn(() => recoveredUnsubscribe),
      bindExtensions: vi.fn().mockResolvedValue(undefined),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
      navigateTree: vi.fn().mockResolvedValue({ cancelled: false }),
      reload: vi.fn().mockResolvedValue(undefined),
      sessionManager: { appendCustomEntry: vi.fn() },
      dispose: vi.fn(),
    } as unknown as AgentSessionLike;
    let beforeSessionInvalidate: (() => void) | undefined;
    const runtime = {
      session: oldInner,
      cwd: "/work/old",
      setBeforeSessionInvalidate: vi.fn((callback?: () => void) => { beforeSessionInvalidate = callback; }),
      setRebindSession: vi.fn(),
      fork: vi.fn(async () => {
        beforeSessionInvalidate?.();
        throw new Error("replacement factory failed");
      }),
      dispose: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentSessionRuntime;
    const recoveredRuntime = {
      session: recoveredInner,
      cwd: "/work/old",
      setBeforeSessionInvalidate: vi.fn(),
      setRebindSession: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentSessionRuntime;
    const recoverRuntime = vi.fn().mockResolvedValue(recoveredRuntime);
    const bridge = new WebExtensionUIBridge({ theme: {} as never });
    const wrapper = new AgentSessionWrapper(oldInner, "/work/old", undefined, [], undefined, bridge);
    wrapper.attachRuntime(runtime, () => undefined, vi.fn(), recoverRuntime);
    wrapper.start();
    const events: unknown[] = [];
    wrapper.onEvent((event) => events.push(event));

    await expect(wrapper.send({ type: "fork", entryId: "entry-1" }))
      .rejects.toThrow("replacement factory failed");

    expect(oldUnsubscribe).toHaveBeenCalledOnce();
    expect(recoverRuntime).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-old",
      sessionFile: "/tmp/session-old.jsonl",
      cwd: "/work/old",
      sessionManager: oldInner.sessionManager,
    }));
    expect(wrapper.inner).toBe(recoveredInner);
    expect(recoveredInner.bindExtensions).toHaveBeenCalledOnce();
    expect(wrapper.getRuntimeDiagnostics()).toMatchObject({
      state: "ready",
      replacementCount: 0,
      lastFailure: { reason: "fork", message: "replacement factory failed", recovered: true },
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "session_replacement_failed",
      reason: "fork",
      recovered: true,
      activeSessionId: "session-old",
    }));
    wrapper.destroy();
  });

  it("rejects an import target owned by another live runtime before replacing", async () => {
    const inner = {
      sessionId: "session-old",
      sessionFile: "/tmp/session-old.jsonl",
      sessionManager: { appendCustomEntry: vi.fn() },
      dispose: vi.fn(),
    } as unknown as AgentSessionLike;
    const importFromJsonl = vi.fn();
    const runtime = {
      session: inner,
      cwd: "/work/old",
      setBeforeSessionInvalidate: vi.fn(),
      setRebindSession: vi.fn(),
      importFromJsonl,
      dispose: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentSessionRuntime;
    const bridge = new WebExtensionUIBridge({ theme: {} as never });
    const wrapper = new AgentSessionWrapper(inner, "/work/old", undefined, [], undefined, bridge);
    wrapper.attachRuntime(
      runtime,
      () => undefined,
      vi.fn(),
      undefined,
      () => { throw new Error("target session is active"); },
    );
    const events: unknown[] = [];
    wrapper.onEvent((event) => events.push(event));

    await expect(wrapper.importSession("/work/old/import.jsonl"))
      .rejects.toThrow("target session is active");
    expect(importFromJsonl).not.toHaveBeenCalled();
    expect(wrapper.getRuntimeDiagnostics()).toMatchObject({
      state: "ready",
      lastFailure: { reason: "import", message: "target session is active", recovered: true },
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "session_replacement_failed",
      reason: "import",
      recovered: true,
      preflight: true,
      activeSessionId: "session-old",
    }));
    wrapper.destroy();
  });

  it("fans out one runtime event to multiple browser-tab listeners", () => {
    let emit: ((event: { type: string }) => void) | undefined;
    const inner = {
      sessionId: "shared-session",
      sessionFile: "/tmp/shared-session.jsonl",
      subscribe: vi.fn((listener: (event: { type: string }) => void) => {
        emit = listener;
        return vi.fn();
      }),
      dispose: vi.fn(),
    } as unknown as AgentSessionLike;
    const wrapper = new AgentSessionWrapper(inner);
    wrapper.start();
    const tabA = vi.fn();
    const tabB = vi.fn();
    const closeA = wrapper.onEvent(tabA);
    wrapper.onEvent(tabB);

    emit?.({ type: "agent_start" });
    closeA();
    emit?.({ type: "agent_end" });

    expect(tabA).toHaveBeenCalledTimes(1);
    expect(tabB).toHaveBeenCalledTimes(2);
    expect(wrapper.getRuntimeDiagnostics().connectedClients).toBe(1);
    wrapper.destroy();
  });
});
