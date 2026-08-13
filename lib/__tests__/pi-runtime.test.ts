import { describe, expect, it, vi } from "vitest";
import {
  bindWebExtensions,
  createAgentModelCatalogRefresher,
  emitWebBeforeFork,
  initializeWebTheme,
  trackExtensionProviders,
} from "../pi-runtime";
import { PI_WEB_OUTPUT_GUIDANCE, appendPiWebOutputGuidance } from "../output-design";

describe("Pi Web runtime integration", () => {
  it("adds Pi Web's optional structured-output guidance without replacing user instructions", () => {
    expect(appendPiWebOutputGuidance(["Project instructions"])).toEqual([
      "Project instructions",
      PI_WEB_OUTPUT_GUIDANCE,
    ]);
  });
  it("refreshes the model runtime only after models.json changes", async () => {
    const calls: string[] = [];
    let modelsVersion = "v1";
    const services = {
      agentDir: "/agent",
      modelRuntime: { refresh: vi.fn(async () => { calls.push("models"); }) },
    };
    const refresh = createAgentModelCatalogRefresher(services, () => modelsVersion);

    await refresh();
    modelsVersion = "v2";
    await refresh();

    expect(calls).toEqual(["models"]);
  });

  it("initializes Pi's extension theme from the session settings without a watcher", () => {
    const initialize = vi.fn();

    initializeWebTheme({ getTheme: () => "dark" }, initialize);

    expect(initialize).toHaveBeenCalledWith("dark", false);
  });

  it("tracks successful and failed extension provider registrations", () => {
    const models: Array<{ id: string; name: string; provider: string }> = [];
    const runtime = {
      registerProvider(name: string, config: { models?: Array<{ id: string; name: string }> }) {
        if (name === "broken") throw new Error("invalid provider");
        for (const model of config.models ?? []) models.push({ ...model, provider: name });
      },
      unregisterProvider(name: string) {
        for (let i = models.length - 1; i >= 0; i--) if (models[i].provider === name) models.splice(i, 1);
      },
      getModels: () => models,
      getAvailableSnapshot: () => models.filter((m) => m.id !== "team-large"),
      getProvider: (name: string) => ({ name: name === "team-ai" ? "Team AI" : name }),
    };
    const tracker = trackExtensionProviders(runtime);
    tracker.discover("team-ai", "/ext/provider.ts");
    tracker.discover("broken", "/ext/broken.ts");

    runtime.registerProvider("team-ai", { models: [
      { id: "team-fast", name: "Team Fast" },
      { id: "team-large", name: "Team Large" },
    ] });
    expect(() => runtime.registerProvider("broken", { models: [] })).toThrow("invalid provider");

    expect(tracker.snapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "team-ai",
        displayName: "Team AI",
        status: "registered",
        modelCount: 2,
        availableModelCount: 1,
        sources: ["/ext/provider.ts"],
      }),
      expect.objectContaining({ name: "broken", status: "error", error: "invalid provider" }),
    ]));

    tracker.beginReload();
    tracker.discover("next-ai", "/ext/next-provider.ts");
    runtime.registerProvider("next-ai", { models: [{ id: "next-fast", name: "Next Fast" }] });
    tracker.finishReload();

    expect(tracker.snapshot().map((provider) => provider.name)).toEqual(["next-ai"]);
    expect(models.map((model) => model.provider)).toEqual(["next-ai"]);
  });

  it("binds the AgentSession extension lifecycle in RPC mode", async () => {
    const bindExtensions = vi.fn().mockResolvedValue(undefined);
    const waitForIdle = vi.fn().mockResolvedValue(undefined);
    const navigateTree = vi.fn().mockResolvedValue({ cancelled: false });
    const reload = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    const uiContext = { select: vi.fn() } as never;

    await bindWebExtensions({ bindExtensions, waitForIdle, navigateTree, reload }, onError, uiContext);

    expect(bindExtensions).toHaveBeenCalledWith(expect.objectContaining({
      mode: "rpc",
      onError,
      uiContext,
      commandContextActions: expect.any(Object),
    }));
    const bindings = bindExtensions.mock.calls[0][0];
    await bindings.commandContextActions.waitForIdle();
    await bindings.commandContextActions.navigateTree("entry-1", { summarize: true });
    await bindings.commandContextActions.reload();
    expect(waitForIdle).toHaveBeenCalledOnce();
    expect(navigateTree).toHaveBeenCalledWith("entry-1", { summarize: true });
    expect(reload).toHaveBeenCalledOnce();
    await expect(bindings.commandContextActions.newSession()).rejects.toThrow("not supported by Pi Web");
  });

  it("delegates session replacement actions when hosted by AgentSessionRuntime", async () => {
    const bindExtensions = vi.fn().mockResolvedValue(undefined);
    const newSession = vi.fn().mockResolvedValue({ cancelled: false });
    const fork = vi.fn().mockResolvedValue({ cancelled: false });
    const switchSession = vi.fn().mockResolvedValue({ cancelled: false });

    await bindWebExtensions(
      {
        bindExtensions,
        waitForIdle: vi.fn().mockResolvedValue(undefined),
        navigateTree: vi.fn().mockResolvedValue({ cancelled: false }),
        reload: vi.fn().mockResolvedValue(undefined),
      },
      vi.fn(),
      {} as never,
      { newSession, fork, switchSession },
    );

    const actions = bindExtensions.mock.calls[0][0].commandContextActions;
    await actions.newSession({ parentSession: "/sessions/parent.jsonl" });
    await actions.fork("entry-1", { position: "at" });
    await actions.switchSession("/sessions/next.jsonl", { cwdOverride: "/work/next" });

    expect(newSession).toHaveBeenCalledWith({ parentSession: "/sessions/parent.jsonl" });
    expect(fork).toHaveBeenCalledWith("entry-1", { position: "at" });
    expect(switchSession).toHaveBeenCalledWith("/sessions/next.jsonl", { cwdOverride: "/work/next" });
  });

  it("lets session_before_fork handlers cancel a Web fork", async () => {
    const emit = vi.fn().mockResolvedValue({ cancel: true });
    const runner = { hasHandlers: vi.fn().mockReturnValue(true), emit };

    await expect(emitWebBeforeFork(runner, "entry-1")).resolves.toBe(false);
    expect(emit).toHaveBeenCalledWith({
      type: "session_before_fork",
      entryId: "entry-1",
      position: "before",
    });
  });
});
