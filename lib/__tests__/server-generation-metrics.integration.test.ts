import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentSessionServices, createAgentSessionFromServices, ModelRuntime,
  SessionManager, SettingsManager, initTheme, type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { AgentSessionWrapper, type AgentEvent } from "../rpc-manager";
import type { AgentSessionLike } from "../pi-types";
import type { AgentMessage, SessionEntry } from "../types";
import { generationMessageKey, type GenerationMetrics } from "../generation-metrics";
import { buildSessionTranscript } from "../session-context";
import { createRunTimingExtension } from "../pi-runtime";

const METRICS_ENTRY = "pi-web-generation-metrics";
// Each provider listener, model catalog, auth path and session file is local to
// a newly created disposable root; no real provider or user store is consulted.
const roots: string[] = [], servers: Server[] = [], wrappers: AgentSessionWrapper[] = [];
const releases: Array<() => void> = [], prompts: Promise<unknown>[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(wrappers.map(wrapper => wrapper.send({ type: "abort" })));
  await Promise.allSettled(prompts.splice(0));
  for (const wrapper of wrappers.splice(0)) wrapper.destroy();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Part {
  text?: string;
  thinking?: string;
  output?: number;
  finish?: string;
  hold?: "before" | "after_delta";
}
function prompt(wrapper: AgentSessionWrapper, message: string) {
  const running = wrapper.send({ type: "prompt", message, awaitCompletion: true });
  prompts.push(running); void running.catch(() => {});
  return running;
}
function metricEvents(events: AgentEvent[]) {
  return events.filter(event => event.type === "message_end"
    && (event.message as { role?: string } | undefined)?.role === "assistant");
}
function metricEntries(session: AgentSession) {
  return session.sessionManager.getEntries().filter(entry => entry.type === "custom" && entry.customType === METRICS_ENTRY);
}
function transcript(session: AgentSession) {
  return buildSessionTranscript(session.sessionManager.getEntries() as unknown as SessionEntry[], session.sessionManager.getLeafId());
}
function finalKey(session: AgentSession): string {
  const message = session.messages.findLast(message => message.role === "assistant");
  expect(message).toBeDefined();
  const key = generationMessageKey(message as AgentMessage); expect(key).toBeTruthy();
  return key!;
}

async function fixture(parts: Part[], keepRecentTokens?: number) {
  const root = mkdtempSync(join(tmpdir(), "pi-server-generation-metrics-")); roots.push(root);
  const cwd = join(root, "project"), agentDir = join(root, "agent"); mkdirSync(cwd); mkdirSync(agentDir);
  const requests: Array<Record<string, unknown>> = [];
  const gates = parts.map(() => {
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    releases.push(release); return { ready, release };
  });
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const index = requests.length; requests.push(JSON.parse(body));
    const part = parts[index];
    if (!part) { response.writeHead(500); response.end("Unexpected fixture request"); return; }
    if (part.hold === "before") await gates[index].ready;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = (delta: object, finish: string | null = null, usage?: object) => `data: ${JSON.stringify({
      id: "offline", object: "chat.completion.chunk", created: 1, model: "offline",
      choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}),
    })}\n\n`;
    response.write(frame({ role: "assistant", ...(part.text ? { content: part.text } : {}),
      ...(part.thinking ? { reasoning_content: part.thinking } : {}),
    }));
    if (part.hold === "after_delta") await gates[index].ready;
    const output = part.output ?? 8;
    response.end(frame({}, part.finish ?? "stop", { prompt_tokens: 10, completion_tokens: output, total_tokens: 10 + output })
      + "data: [DONE]\n\n");
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  servers.push(server);
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture address");
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { "metrics-fixture": {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "local-fixture-only",
    models: [{ id: "offline", name: "Offline", reasoning: true, input: ["text"], contextWindow: 32768, maxTokens: 256,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  async function open(manager: SessionManager) {
    const observation: { wrapper?: AgentSessionWrapper } = {};
    const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false, ...(keepRecentTokens ? { keepRecentTokens } : {}) }, retry: {
        enabled: false, provider: { maxRetries: 0 },
      } }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        extensionFactories: [createRunTimingExtension(() => observation.wrapper?.markProviderRequest())] },
    });
    expect(services.resourceLoader.getExtensions().errors).toEqual([]); initTheme("dark", false);
    const { session } = await createAgentSessionFromServices({ services, sessionManager: manager,
      model: modelRuntime.getModel("metrics-fixture", "offline"), thinkingLevel: "off", tools: [],
    });
    const sdkEvents: AgentEvent[] = []; session.subscribe(event => sdkEvents.push(event as unknown as AgentEvent));
    const wrapper = new AgentSessionWrapper(session as unknown as AgentSessionLike); wrappers.push(wrapper); observation.wrapper = wrapper;
    const events: AgentEvent[] = []; wrapper.onEvent(event => events.push(event as AgentEvent)); wrapper.start();
    return { session, wrapper, events, sdkEvents };
  }
  const initial = await open(SessionManager.create(cwd, join(root, "sessions")));
  return { ...initial, requests, release: (index: number) => gates[index].release(),
    async reopen(session: AgentSession, wrapper: AgentSessionWrapper) {
      const file = session.sessionFile;
      if (!file) throw new Error("Expected a persisted fixture session");
      wrapper.destroy(); wrappers.splice(wrappers.indexOf(wrapper), 1);
      return open(SessionManager.open(file));
    },
  };
}

describe("server generation metrics through the real Pi SDK and loopback provider", () => {
  it("measures one buffered content delta, persists independently of browsers and reloads without changing model context", async () => {
    const f = await fixture([{ text: "One buffered answer.", thinking: "Reasoning tokens are included in provider usage.", output: 37, hold: "before" },
      { text: "A second answer after reopening.", output: 11 }]);
    const running = prompt(f.wrapper, "Return a buffered answer");
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    // A real observed wait before the only content delta tests TTFT inclusion;
    // it does not invent additional streaming updates or a browser-side clock.
    await new Promise(resolve => setTimeout(resolve, 20)); f.release(0); await running;
    const end = metricEvents(f.events)[0];
    expect(end?.generationMetrics).toMatchObject({ tokens: 37, estimated: false, source: "server" });
    const metrics = end.generationMetrics as GenerationMetrics;
    expect(metrics.seconds).toBeGreaterThan(0); expect(metrics.seconds).toBeLessThan(1);
    expect(metrics.firstContentSeconds).toBeGreaterThanOrEqual(0.02);
    expect(metrics.firstContentSeconds).toBeLessThanOrEqual(metrics.seconds);
    expect(f.sdkEvents.filter(event => event.type === "message_update"
      && (event.assistantMessageEvent as { type?: string } | undefined)?.type === "text_delta")).toHaveLength(1);
    const rawEnd = metricEvents(f.sdkEvents)[0];
    expect(rawEnd).not.toHaveProperty("generationMetrics");
    expect(rawEnd.message).not.toHaveProperty("generationMetrics");
    expect(f.session.messages.at(-1)).not.toHaveProperty("generationMetrics");
    const key = finalKey(f.session), file = f.session.sessionFile!;
    await vi.waitFor(() => expect(metricEntries(f.session)).toHaveLength(1));
    const metadata = metricEntries(f.session)[0];
    const answer = f.session.sessionManager.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "assistant")!;
    expect(metadata).toMatchObject({ type: "custom", customType: METRICS_ENTRY,
      data: { version: 1, entryId: answer.id, key, metrics } });
    const visible = transcript(f.session);
    expect(visible.generationMetrics).toEqual({ [key]: metrics });
    expect(visible.entryIds).toEqual(f.session.sessionManager.getBranch().filter(entry => entry.type === "message"
      && ["user", "assistant"].includes(entry.message.role)).map(entry => entry.id));
    expect(visible.messages.map(message => message.role)).toEqual(["user", "assistant"]);
    expect(readFileSync(file, "utf8")).toContain(METRICS_ENTRY);
    expect(JSON.stringify(f.session.sessionManager.buildSessionContext())).not.toContain(METRICS_ENTRY);
    expect(JSON.stringify(f.session.sessionManager.buildSessionContext())).not.toContain(key);
    const reopened = await f.reopen(f.session, f.wrapper);
    expect(transcript(reopened.session).generationMetrics).toEqual({ [key]: metrics });
    expect(reopened.session.messages.filter(message => message.role !== "system").map(message => message.role)).toEqual(["user", "assistant"]);
    await prompt(reopened.wrapper, "Use the prior answer without exposing diagnostic metadata");
    expect(f.requests).toHaveLength(2);
    expect(JSON.stringify(f.requests[1])).not.toContain(METRICS_ENTRY);
    expect(JSON.stringify(f.requests[1])).not.toContain(key);
    expect(JSON.stringify(f.requests[1])).not.toContain("generationMetrics");
    expect(reopened.session.messages.filter(message => message.role === "user")).toHaveLength(2);
    await vi.waitFor(() => expect(metricEntries(reopened.session)).toHaveLength(2));
    expect(transcript(reopened.session).generationMetrics?.[key]).toEqual(metrics);
    expect(metricEvents(reopened.events)[0]?.generationMetrics).toMatchObject({ tokens: 11, estimated: false, source: "server" });
  });

  it("retains a reliable visible-partial estimate for a failed answer without counting private reasoning", async () => {
    const f = await fixture([{ text: "VISIBLE_ONLY_1234", thinking: "PRIVATE_REASONING_SHOULD_NOT_COUNT".repeat(8), output: 0, finish: "network_error" }]);
    await prompt(f.wrapper, "Exercise a partial provider failure");
    expect(f.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
    const metrics = metricEvents(f.events)[0]?.generationMetrics as GenerationMetrics;
    expect(metrics).toMatchObject({ tokens: 4, estimated: true, source: "server" });
    expect(metrics.seconds).toBeGreaterThan(0);
    await vi.waitFor(() => expect(metricEntries(f.session)).toHaveLength(1));
    expect(transcript(f.session).generationMetrics?.[finalKey(f.session)]).toEqual(metrics);
    expect(f.session.messages.at(-1)).not.toHaveProperty("generationMetrics");
  });

  it("keeps a server-observed partial measurement after an explicit Stop while preserving the aborted outcome", async () => {
    const f = await fixture([{ text: "VISIBLE_ONLY_1234", thinking: "PRIVATE_ABORTED_REASONING".repeat(8), hold: "after_delta" }]);
    const running = prompt(f.wrapper, "Abort after visible partial output");
    await vi.waitFor(() => expect(f.events.some(event => event.type === "message_update"
      && JSON.stringify(event.message).includes("VISIBLE_ONLY_1234"))).toBe(true));
    await f.wrapper.send({ type: "abort" }); await running; f.release(0);
    expect(f.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
    const metrics = metricEvents(f.events)[0]?.generationMetrics as GenerationMetrics;
    expect(metrics).toMatchObject({ tokens: 4, estimated: true, source: "server" });
    expect(metrics.seconds).toBeGreaterThan(0);
    await vi.waitFor(() => expect(metricEntries(f.session)).toHaveLength(1));
    expect(transcript(f.session).generationMetrics?.[finalKey(f.session)]).toEqual(metrics);
    expect(f.events.findLast(event => event.type === "agent_end")).toMatchObject({ runOutcome: "stopped" });
  });

  it("resumes the current task after a metrics entry advanced the saved leaf and records the next response independently", async () => {
    const f = await fixture([{ text: "Saved progress before provider failure", output: 7, finish: "network_error" },
      { text: "Finished the same task from saved progress", output: 13 }]);
    await prompt(f.wrapper, "Finish this task from saved progress");
    await vi.waitFor(() => expect(metricEntries(f.session)).toHaveLength(1));
    const initialKey = finalKey(f.session);
    const initialMetrics = transcript(f.session).generationMetrics![initialKey];
    const source = f.session.sessionManager.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "assistant")!;
    const metadataLeaf = f.session.sessionManager.getLeafId()!;
    expect(metadataLeaf).toBe(metricEntries(f.session)[0].id);
    expect(metadataLeaf).not.toBe(source.id);
    const userPrompt = vi.spyOn(f.session, "prompt"), navigate = vi.spyOn(f.session, "navigateTree");
    await expect(f.wrapper.send({ type: "resume", requestId: "metrics-resume", expectedLeafId: metadataLeaf, awaitCompletion: true }))
      .resolves.toMatchObject({ accepted: true });
    expect(userPrompt).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled();
    expect(f.events.find(event => event.type === "task_resume_started")).toMatchObject({
      runState: { continuing: true },
    });
    expect(f.session.sessionManager.getEntries().filter(entry => entry.type === "custom_message"
      && entry.customType === "pi-web-task-resume")).toMatchObject([{
      parentId: metadataLeaf, display: false, details: { requestId: "metrics-resume", sourceEntryId: source.id },
    }]);
    expect(f.session.messages.filter(message => message.role === "user")).toHaveLength(1);
    expect(f.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
    await vi.waitFor(() => expect(metricEntries(f.session)).toHaveLength(2));
    expect(metricEvents(f.events).map(event => (event.generationMetrics as GenerationMetrics).tokens)).toEqual([7, 13]);
    const complete = transcript(f.session);
    expect(complete.generationMetrics).toEqual({
      [initialKey]: initialMetrics,
      [finalKey(f.session)]: metricEvents(f.events)[1].generationMetrics,
    });
    expect(complete.messages.filter(message => message.role === "user")).toHaveLength(1);
    expect(JSON.stringify(complete.messages)).not.toContain("Task recovery control");
    expect(f.requests).toHaveLength(2);
    expect(JSON.stringify(f.requests[1])).not.toContain(METRICS_ENTRY);
    expect(JSON.stringify(f.requests[1])).not.toContain(initialKey);
  });

  it("keeps completed measurements across actual SDK compaction without treating its summary as another answer", async () => {
    const f = await fixture([{ text: "A saved answer whose statistics must survive compaction.", output: 17 },
      { text: "# Summary\nThe first user request and completed answer were preserved.", output: 5 },
      { text: "A new answer after compaction.", output: 9 }], 1);
    await prompt(f.wrapper, "Save this first answer before compacting");
    await vi.waitFor(() => expect(metricEntries(f.session)).toHaveLength(1));
    const initialKey = finalKey(f.session), initialMetrics = transcript(f.session).generationMetrics![initialKey];
    const before = transcript(f.session);
    const compacted = await f.session.compact("Summarize only the saved fixture work");
    expect(compacted.summary).toContain("first user request");
    expect(f.requests).toHaveLength(2);
    expect(metricEntries(f.session)).toHaveLength(1);
    expect(metricEvents(f.events)).toHaveLength(1);
    expect(f.events.some(event => event.type === "compaction_start")).toBe(true);
    expect(f.events.findLast(event => event.type === "compaction_end")).toMatchObject({ aborted: false });
    const after = transcript(f.session);
    expect(after.entryIds.slice(0, before.entryIds.length)).toEqual(before.entryIds);
    expect(after.generationMetrics).toEqual({ [initialKey]: initialMetrics });
    expect(JSON.stringify(f.requests[1])).not.toContain(METRICS_ENTRY);
    expect(JSON.stringify(f.requests[1])).not.toContain(initialKey);
    await prompt(f.wrapper, "Answer a new question after compacting");
    await vi.waitFor(() => expect(metricEntries(f.session)).toHaveLength(2));
    expect(f.requests).toHaveLength(3);
    expect(metricEvents(f.events).map(event => (event.generationMetrics as GenerationMetrics).tokens)).toEqual([17, 9]);
    expect(transcript(f.session).generationMetrics).toEqual({
      [initialKey]: initialMetrics,
      [finalKey(f.session)]: metricEvents(f.events)[1].generationMetrics,
    });
    expect(JSON.stringify(f.requests[2])).not.toContain(METRICS_ENTRY);
    expect(JSON.stringify(f.requests[2])).not.toContain(initialKey);
  });

  it("does not fabricate completed statistics from a thinking-only answer with no provider output count", async () => {
    const f = await fixture([{ thinking: "No visible text or usable output count", output: 0 }]);
    await prompt(f.wrapper, "Exercise missing output evidence");
    expect(f.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
    expect(metricEvents(f.events)[0]).not.toHaveProperty("generationMetrics");
    expect(metricEntries(f.session)).toHaveLength(0);
    expect(transcript(f.session).generationMetrics ?? {}).toEqual({});
    expect(f.requests).toHaveLength(1);
  });
});
