import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Type } from "typebox";
import {
  createAgentSessionServices, createAgentSessionFromServices, defineTool, ModelRegistry, ModelRuntime,
  SessionManager, SettingsManager, initTheme, type AgentSession, type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { AgentSessionWrapper, type AgentEvent } from "../rpc-manager";
import type { AgentSessionLike } from "../pi-types";
import type { GenerationSettingsState } from "../generation-settings";
import { TASK_RESUME_ENTRY } from "../task-resume";

const PROVIDER = "generation-fixture";
const roots: string[] = [], servers: Server[] = [], wrappers: AgentSessionWrapper[] = [];
const releases: Array<() => void> = [], running: Promise<unknown>[] = [];

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(wrappers.map(wrapper => wrapper.send({ type: "abort" })));
  await Promise.allSettled(running.splice(0));
  for (const wrapper of wrappers.splice(0)) wrapper.destroy();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

interface ResponsePart {
  text?: string;
  thinking?: string;
  tool?: boolean;
  hold?: "before" | "after_delta";
}

function gate() {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  releases.push(release);
  return { ready, release };
}

function track<T>(promise: Promise<T>): Promise<T> {
  running.push(promise);
  void promise.catch(() => {});
  return promise;
}

function snapshot(wrapper: AgentSessionWrapper): GenerationSettingsState {
  return (wrapper.getStreamSnapshot() as unknown as {
    state: { generationSettings: GenerationSettingsState };
  }).state.generationSettings;
}

function prompt(wrapper: AgentSessionWrapper) {
  return track(wrapper.send({ type: "prompt", message: "Finish this task using the saved work", awaitCompletion: true }));
}

function configure(wrapper: AgentSessionWrapper, thinkingLevel: string, modelId?: string) {
  return wrapper.send({ type: "configure_generation", thinkingLevel,
    ...(modelId ? { model: { provider: PROVIDER, modelId } } : {}),
  }) as Promise<GenerationSettingsState>;
}

function restartCommand(wrapper: AgentSessionWrapper, requestId: string) {
  const settings = snapshot(wrapper);
  return {
    type: "resume", requestId, stopCurrentRun: true, expectedRunId: settings.runId,
    expectedSettingsRevision: settings.revision, awaitCompletion: true,
  };
}

function receipts(session: AgentSession) {
  return session.sessionManager.getEntries().filter(entry => entry.type === "custom_message")
    .filter(entry => entry.customType === TASK_RESUME_ENTRY);
}

async function fixture(parts: ResponsePart[], options: {
  settings?: Parameters<typeof SettingsManager.inMemory>[0];
  holdAbortedSettlement?: boolean;
  holdResumedPreparation?: boolean;
} = {}) {
  // All model/auth/session paths and traffic are confined to this disposable fixture.
  const root = mkdtempSync(join(tmpdir(), "pi-generation-settings-")); roots.push(root);
  const cwd = join(root, "project"), agentDir = join(root, "agent"); mkdirSync(cwd); mkdirSync(agentDir);
  const requests: Array<Record<string, unknown>> = [];
  const gates = parts.map(() => gate());
  const settlement = gate();
  const preparation = gate();
  let settlementEntered = false;
  let preparationEntered = false;
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const index = requests.length;
    const payload = JSON.parse(body) as Record<string, unknown>;
    requests.push(payload);
    const part = parts[index];
    if (!part) { response.writeHead(500); response.end("Unexpected extra fixture request"); return; }
    if (part.hold === "before") await gates[index].ready;
    if (response.destroyed) return;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = (delta: object, finish: string | null = null, usage?: object) => `data: ${JSON.stringify({
      id: `fixture-${index}`, object: "chat.completion.chunk", created: 1, model: payload.model,
      choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}),
    })}\n\n`;
    response.write(frame({
      role: "assistant", ...(part.text ? { content: part.text } : {}),
      ...(part.thinking ? { reasoning_content: part.thinking } : {}),
      ...(part.tool ? { tool_calls: [{ index: 0, id: "saved-work-call", type: "function",
        function: { name: "fixture_once", arguments: "{}" } }] } : {}),
    }));
    if (part.hold === "after_delta") await gates[index].ready;
    if (response.destroyed) return;
    response.end(frame({}, part.tool ? "tool_calls" : "stop",
      { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 }) + "data: [DONE]\n\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
  }); servers.push(server);
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture address");
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { [PROVIDER]: {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "local-fixture-only",
    models: ["alpha", "beta", "plain"].map(id => ({
      id, name: id, reasoning: id !== "plain", input: ["text"], contextWindow: 32768, maxTokens: 256,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
  } } }));
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
    refreshOnCreate: false, allowModelNetwork: false,
  });
  let toolExecutions = 0;
  const tool = defineTool({
    name: "fixture_once", label: "Fixture once", description: "Return completed fixture work",
    parameters: Type.Object({}), async execute() {
      toolExecutions++;
      return { content: [{ type: "text", text: "SAVED_GENERATION_WORK_42" }], details: { completed: true } };
    },
  });
  const extensionFactories: InlineExtension[] = options.holdAbortedSettlement ? [{
    name: "Fixture settlement barrier", factory(pi) {
      pi.on("agent_settled", async event => {
        if (!event.aborted || settlementEntered) return;
        settlementEntered = true;
        await settlement.ready;
      });
    },
  }] : [];
  if (options.holdResumedPreparation) extensionFactories.push({
    name: "Fixture resumed preparation barrier", factory(pi) {
      let starts = 0;
      pi.on("before_agent_start", async () => {
        if (++starts !== 2) return;
        preparationEntered = true;
        await preparation.ready;
      });
    },
  });
  const services = await createAgentSessionServices({
    cwd, agentDir, modelRuntime,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } },
      ...options.settings,
    }),
    resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories,
    },
  });
  expect(services.resourceLoader.getExtensions().errors).toEqual([]); initTheme("dark", false);
  const { session } = await createAgentSessionFromServices({
    services, sessionManager: SessionManager.create(cwd, join(root, "sessions")),
    model: modelRuntime.getModel(PROVIDER, "alpha"), thinkingLevel: "low",
    tools: ["fixture_once"], customTools: [tool],
  });
  const wrapper = new AgentSessionWrapper(session as unknown as AgentSessionLike, "", undefined, [],
    undefined, undefined, new ModelRegistry(modelRuntime));
  wrappers.push(wrapper);
  const events: AgentEvent[] = [];
  wrapper.onEvent(event => events.push(event as AgentEvent)); wrapper.start();
  return {
    session, wrapper, requests, events, release: (index: number) => gates[index].release(),
    toolExecutions: () => toolExecutions, settlementEntered: () => settlementEntered,
    releaseSettlement: settlement.release,
    preparationEntered: () => preparationEntered, releasePreparation: preparation.release,
  };
}

async function waitForText(events: AgentEvent[], text: string) {
  await vi.waitFor(() => expect(events.some(event => event.type === "message_update"
    && JSON.stringify(event).includes(text))).toBe(true));
}

describe("generation settings through the real Pi SDK and loopback provider", () => {
  it("keeps the held stream unchanged and applies the accepted selection at the next tool request", async () => {
    const f = await fixture([
      { text: "First streamed work", tool: true, hold: "after_delta" },
      { text: "Finished with new settings", hold: "after_delta" },
    ]);
    const abort = vi.spyOn(f.session, "abort");
    const original = prompt(f.wrapper);
    await waitForText(f.events, "First streamed work");
    expect(f.requests[0]).toMatchObject({ model: "alpha", reasoning_effort: "low" });
    const initial = snapshot(f.wrapper);
    expect(initial).toMatchObject({
      active: { provider: PROVIDER, modelId: "alpha", thinkingLevel: "low" }, pending: false,
    });
    const firstRequest = JSON.stringify(f.requests[0]);
    const accepted = await configure(f.wrapper, "high", "beta");
    expect(accepted).toMatchObject({
      selected: { provider: PROVIDER, modelId: "beta", thinkingLevel: "high" },
      active: initial.active, revision: initial.revision + 1, pending: true, runId: initial.runId,
    });
    expect(snapshot(f.wrapper)).toEqual(accepted);
    expect(f.requests).toHaveLength(1); expect(JSON.stringify(f.requests[0])).toBe(firstRequest);
    expect(abort).not.toHaveBeenCalled();
    expect(f.session.isStreaming).toBe(true);
    f.release(0);
    await vi.waitFor(() => expect(f.requests).toHaveLength(2));
    expect(f.requests[1]).toMatchObject({ model: "beta", reasoning_effort: "high" });
    expect(snapshot(f.wrapper)).toMatchObject({
      selected: accepted.selected, active: accepted.selected, pending: false, revision: accepted.revision,
    });
    expect(f.events.some(event => event.type === "generation_settings_changed"
      && (event.settings as GenerationSettingsState).pending)).toBe(true);
    expect(f.toolExecutions()).toBe(1);
    f.release(1); await original;
    const assistants = f.session.messages.filter(message => message.role === "assistant");
    expect(assistants).toMatchObject([
      { model: "alpha", thinkingLevel: "low", stopReason: "toolUse" },
      { model: "beta", thinkingLevel: "high", stopReason: "stop" },
    ]);
    expect(f.session.messages.filter(message => message.role === "user")).toHaveLength(1);
  });

  it("resets auto through per-model, global and SDK defaults and lets the SDK clamp nonreasoning models", async () => {
    const cases: Array<{
      model: string;
      settings: NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>;
      expected: string;
    }> = [
      { model: "alpha", settings: { modelThinkingLevels: { [`${PROVIDER}/alpha`]: "high" }, defaultThinkingLevel: "minimal" }, expected: "high" },
      { model: "alpha", settings: { defaultThinkingLevel: "minimal" }, expected: "minimal" },
      { model: "alpha", settings: {}, expected: "medium" },
      { model: "plain", settings: { modelThinkingLevels: { [`${PROVIDER}/plain`]: "high" }, defaultThinkingLevel: "high" }, expected: "off" },
    ];
    for (const item of cases) {
      const f = await fixture([{ text: "Applied default" }], { settings: item.settings });
      const accepted = await configure(f.wrapper, "auto", item.model);
      expect(accepted.selected).toEqual({ provider: PROVIDER, modelId: item.model, thinkingLevel: item.expected });
      expect(accepted.pending).toBe(false);
      await prompt(f.wrapper);
      expect(f.requests[0].model).toBe(item.model);
      expect(f.requests[0].reasoning_effort).toBe(item.expected === "off" ? undefined : item.expected);
      expect(f.events.some(event => event.type === "generation_settings_changed"
        && JSON.stringify((event.settings as GenerationSettingsState).active) === JSON.stringify(accepted.selected))).toBe(true);
      expect(snapshot(f.wrapper)).toMatchObject({ selected: accepted.selected, active: null, pending: false });
      expect(f.session.settingsManager.getDefaultThinkingLevel()).toBe(item.settings.defaultThinkingLevel);
    }
  });

  it("awaits SDK stop settlement, then resumes once with partial text and completed tool results on the existing branch", async () => {
    const f = await fixture([
      { tool: true },
      { text: "VISIBLE_PARTIAL_WORK", thinking: "PRIVATE_PARTIAL_THINKING", hold: "after_delta" },
      { text: "Finished after changing settings", hold: "after_delta" },
    ]);
    const original = prompt(f.wrapper);
    await waitForText(f.events, "VISIBLE_PARTIAL_WORK");
    expect(f.toolExecutions()).toBe(1);
    const before = f.session.sessionManager.getBranch().map(entry => entry.id);
    const accepted = await configure(f.wrapper, "high", "beta");
    expect(accepted.canRestart).toBe(true);
    const idleAtResume: boolean[] = [];
    const sendCustomMessage = f.session.sendCustomMessage.bind(f.session);
    vi.spyOn(f.session, "sendCustomMessage").mockImplementation((message, options) => {
      idleAtResume.push(f.session.isIdle);
      return sendCustomMessage(message, options);
    });
    const abort = vi.spyOn(f.session, "abort");
    const resumed = track(f.wrapper.send(restartCommand(f.wrapper, "settings-resume")));
    await vi.waitFor(() => expect(f.requests).toHaveLength(3));
    await original;
    expect(abort).toHaveBeenCalledTimes(1); expect(idleAtResume).toEqual([true]);
    expect(f.requests[2]).toMatchObject({ model: "beta", reasoning_effort: "high" });
    expect(f.requests[2].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool", tool_call_id: "saved-work-call", content: "SAVED_GENERATION_WORK_42" }),
    ]));
    expect(JSON.stringify(f.requests[2])).toContain("VISIBLE_PARTIAL_WORK");
    expect(JSON.stringify(f.requests[2])).not.toContain("PRIVATE_PARTIAL_THINKING");
    expect(f.session.sessionManager.getBranch().slice(0, before.length).map(entry => entry.id)).toEqual(before);
    expect(f.session.messages.filter(message => message.role === "user")).toHaveLength(1);
    expect(f.session.messages.filter(message => message.role === "toolResult")).toHaveLength(1);
    expect(f.toolExecutions()).toBe(1); expect(receipts(f.session)).toHaveLength(1);
    expect(snapshot(f.wrapper)).toMatchObject({ active: accepted.selected, pending: false });
    f.release(2);
    await expect(resumed).resolves.toMatchObject({ accepted: true });
  });

  it.each(["run", "revision"] as const)("rejects a stale %s guard without stopping the current request", async guard => {
    const f = await fixture([{ text: "Keep this stream running", hold: "after_delta" }]);
    prompt(f.wrapper);
    await waitForText(f.events, "Keep this stream running");
    await configure(f.wrapper, "high", "beta");
    const command = restartCommand(f.wrapper, `stale-${guard}`);
    const stale = guard === "run" ? { expectedRunId: "old-run" }
      : { expectedSettingsRevision: command.expectedSettingsRevision - 1 };
    const abort = vi.spyOn(f.session, "abort");
    await expect(f.wrapper.send({ ...command, ...stale })).rejects.toThrow(/changed/i);
    expect(abort).not.toHaveBeenCalled();
    expect(f.session.isStreaming).toBe(true); expect(f.requests).toHaveLength(1);
    expect(receipts(f.session)).toHaveLength(0);
  });

  it("admits duplicate stop-and-resume request IDs only once while the resumed stream is pending", async () => {
    const f = await fixture([
      { text: "Interrupted once", hold: "after_delta" },
      { text: "One resumed response", hold: "after_delta" },
    ]);
    const original = prompt(f.wrapper);
    await waitForText(f.events, "Interrupted once");
    await configure(f.wrapper, "high", "beta");
    const abort = vi.spyOn(f.session, "abort");
    const command = restartCommand(f.wrapper, "same-settings-resume");
    const first = track(f.wrapper.send(command));
    const duplicate = track(f.wrapper.send(command));
    await vi.waitFor(() => expect(f.requests).toHaveLength(2));
    expect(abort).toHaveBeenCalledTimes(1); expect(receipts(f.session)).toHaveLength(1);
    expect(f.session.messages.filter(message => message.role === "user")).toHaveLength(1);
    f.release(1); await original;
    await expect(first).resolves.toMatchObject({ accepted: true });
    await expect(duplicate).resolves.toMatchObject({ accepted: true });
    await expect(f.wrapper.send(command)).resolves.toMatchObject({ accepted: true });
    expect(f.requests).toHaveLength(2); expect(receipts(f.session)).toHaveLength(1);
  });

  it("honors a new user Stop during SDK settlement and prevents the pending settings resume", async () => {
    const f = await fixture([{ text: "Work before cancellation", hold: "after_delta" }], { holdAbortedSettlement: true });
    const original = prompt(f.wrapper);
    await waitForText(f.events, "Work before cancellation");
    await configure(f.wrapper, "high", "beta");
    const resumed = track(f.wrapper.send(restartCommand(f.wrapper, "cancel-settings-restart")));
    await vi.waitFor(() => expect(f.settlementEntered()).toBe(true));
    expect(snapshot(f.wrapper).restarting).toBe(true);
    await f.wrapper.send({ type: "abort" });
    f.releaseSettlement();
    await expect(resumed).rejects.toThrow(/cancelled/i); await original;
    expect(f.requests).toHaveLength(1); expect(receipts(f.session)).toHaveLength(0);
    expect(f.session.isIdle).toBe(true); expect(snapshot(f.wrapper).restarting).toBe(false);
    expect(f.session.messages.filter(message => message.role === "user")).toHaveLength(1);
  });

  it("keeps stop-and-resume active during delayed preparation and honors Stop before its next request", async () => {
    const f = await fixture([
      { text: "Saved work before settings restart", hold: "after_delta" },
      { text: "This request must not run after Stop" },
    ], { holdResumedPreparation: true });
    const original = prompt(f.wrapper);
    await waitForText(f.events, "Saved work before settings restart");
    await configure(f.wrapper, "high", "beta");
    const abort = vi.spyOn(f.session, "abort");
    const resumed = track(f.wrapper.send({
      ...restartCommand(f.wrapper, "stop-during-resumed-preparation"), awaitCompletion: false,
    }));
    await vi.waitFor(() => expect(f.preparationEntered()).toBe(true));
    await expect(resumed).resolves.toMatchObject({ accepted: true });
    await original;
    expect(f.session.isStreaming).toBe(true);
    expect(f.requests).toHaveLength(1);
    expect(abort).toHaveBeenCalledTimes(1);
    const expectedPreparing = {
      isStreaming: true, generationSettings: { restarting: true, canRestart: false },
    };
    // Keep exercising Stop even when the state assertion reproduces the bug.
    expect.soft(await f.wrapper.send({ type: "get_state" })).toMatchObject(expectedPreparing);
    expect.soft(f.wrapper.getStreamSnapshot()).toMatchObject({ state: expectedPreparing });

    let stopSettled = false;
    const stopped = track(f.wrapper.send({ type: "abort" }).then(result => {
      stopSettled = true;
      return result;
    }));
    await vi.waitFor(() => expect(abort).toHaveBeenCalledTimes(2));
    expect(stopSettled).toBe(false);
    expect(f.requests).toHaveLength(1);
    f.releasePreparation();
    await stopped;
    await vi.waitFor(() => expect(f.session.isIdle).toBe(true));
    expect(f.wrapper.getStreamSnapshot()).toMatchObject({
      state: { isStreaming: false, generationSettings: { restarting: false } },
    });
    expect(f.requests).toHaveLength(1);
    expect(f.toolExecutions()).toBe(0);
    expect(f.session.messages.filter(message => message.role === "user")).toHaveLength(1);
  });
});
