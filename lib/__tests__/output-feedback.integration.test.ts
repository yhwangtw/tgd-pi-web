import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentSessionServices, createAgentSessionFromServices, ModelRuntime,
  SessionManager, SettingsManager, initTheme,
} from "@earendil-works/pi-coding-agent";
import { AgentSessionWrapper, type AgentEvent } from "../rpc-manager";
import type { AgentSessionLike } from "../pi-types";
import type { AgentRunState } from "../agent-run-state";
import { createOutputRecoveryExtension, OUTPUT_RECOVERY_ENTRY } from "../output-recovery-extension";

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

interface ResponsePart { text?: string; output?: number; finish?: string; status?: number; hold?: boolean }
interface FeedbackSnapshot {
  state: { isStreaming: boolean; runState: AgentRunState | null };
  lastRunOutcome: "stopped" | null;
}
function snapshot(wrapper: AgentSessionWrapper): FeedbackSnapshot {
  return wrapper.getStreamSnapshot() as unknown as FeedbackSnapshot;
}
function prompt(wrapper: AgentSessionWrapper, message: string) {
  const running = wrapper.send({ type: "prompt", message, awaitCompletion: true });
  prompts.push(running);
  return running;
}

async function fixture(parts: ResponsePart[], retryDelayMs = 0) {
  const root = mkdtempSync(join(tmpdir(), "pi-output-feedback-")); roots.push(root);
  const cwd = join(root, "project"), agentDir = join(root, "agent"); mkdirSync(cwd); mkdirSync(agentDir);
  const requests: Array<Record<string, unknown>> = [];
  const gates = parts.map(() => {
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    releases.push(release);
    return { ready, release };
  });
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const index = requests.length;
    requests.push(JSON.parse(body));
    const part = parts[index];
    if (!part) { response.writeHead(500); response.end("Unexpected extra request"); return; }
    if (part.hold) await gates[index].ready;
    if (part.status) {
      response.writeHead(part.status, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Service unavailable", type: "server_error" } }));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = (delta: object, finish: string | null = null, usage?: object) => `data: ${JSON.stringify({
      id: "offline", object: "chat.completion.chunk", created: 1, model: "offline",
      choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}),
    })}\n\n`;
    const output = part.output ?? 8;
    response.end(frame({ role: "assistant", content: part.text ?? "" })
      + frame({}, part.finish ?? "stop", { prompt_tokens: 10, completion_tokens: output, total_tokens: 10 + output })
      + "data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); servers.push(server);
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing local fixture address");
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { "feedback-fixture": {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "local-fixture-only",
    models: [{ id: "offline", name: "Offline", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 64,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false,
  });
  const services = await createAgentSessionServices({
    cwd, agentDir, modelRuntime,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: {
      enabled: retryDelayMs > 0, maxRetries: 1, baseDelayMs: retryDelayMs, maxAgentDelayMs: retryDelayMs,
      provider: { maxRetries: 0 },
    } }),
    resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [createOutputRecoveryExtension()],
    },
  });
  expect(services.resourceLoader.getExtensions().errors).toEqual([]); initTheme("dark", false);
  const { session } = await createAgentSessionFromServices({
    services, sessionManager: SessionManager.create(cwd, join(root, "sessions")),
    model: modelRuntime.getModel("feedback-fixture", "offline"), thinkingLevel: "off", tools: [],
  });
  const sdkEvents: AgentEvent[] = [];
  session.subscribe(event => sdkEvents.push(event as unknown as AgentEvent));
  const wrapper = new AgentSessionWrapper(session as unknown as AgentSessionLike); wrappers.push(wrapper);
  const observed: Array<{ event: AgentEvent; snapshot: FeedbackSnapshot }> = [];
  wrapper.onEvent(event => observed.push({ event: event as AgentEvent, snapshot: snapshot(wrapper) }));
  wrapper.start();
  return { session, wrapper, requests, sdkEvents, observed, release: (index: number) => gates[index].release() };
}

function firstRun(observed: Array<{ event: AgentEvent }>): AgentRunState {
  const event = observed.find(item => item.event.type === "agent_start")?.event;
  expect(event?.runState).toMatchObject({ id: expect.any(String), startedAt: expect.any(Number) });
  return event!.runState as AgentRunState;
}

describe("output feedback through the real Pi SDK and loopback SSE provider", () => {
  it("reports continuation while the capped answer's next response is pending without duplicating the user prompt", async () => {
    const f = await fixture([
      { text: "Partial answer", output: 64, finish: "length" },
      { text: "Remaining answer", hold: true },
    ]);
    const running = prompt(f.wrapper, "Give the complete answer");
    await vi.waitFor(() => expect(f.requests).toHaveLength(2));
    const initial = firstRun(f.observed);
    expect(snapshot(f.wrapper)).toMatchObject({ state: { isStreaming: true, runState: {
      id: initial.id, startedAt: initial.startedAt, continuing: true,
    } } });
    expect(f.observed.filter(item => item.event.type === "agent_end")).toHaveLength(0);
    expect(f.session.messages.filter(message => message.role === "user")).toHaveLength(1);
    expect(f.session.sessionManager.getEntries().filter(entry => entry.type === "custom_message"
      && entry.customType === OUTPUT_RECOVERY_ENTRY)).toMatchObject([{ display: false }]);
    f.release(1); await running;
    expect(f.sdkEvents.filter(event => event.type === "agent_start")).toHaveLength(1);
    expect(f.sdkEvents.filter(event => event.type === "agent_end")).toHaveLength(1);
    expect(f.session.messages.filter(message => message.role === "user")).toHaveLength(1);
    expect(f.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop",
      content: [{ type: "text", text: "Remaining answer" }] });
    expect(snapshot(f.wrapper)).toMatchObject({ state: { isStreaming: false, runState: null } });
  });

  it("keeps one running identity and start time across a retryable 503, backoff, and resumed response", async () => {
    const f = await fixture([{ status: 503 }, { text: "Recovered answer", hold: true }], 200);
    const running = prompt(f.wrapper, "Retry this answer");
    await vi.waitFor(() => expect(f.observed.some(item => item.event.type === "auto_retry_start")).toBe(true));
    const initial = firstRun(f.observed);
    const retryBoundary = f.observed.find(item => item.event.type === "agent_end" && item.event.willRetry === true);
    expect(retryBoundary?.snapshot).toMatchObject({ state: { isStreaming: true, runState: {
      id: initial.id, startedAt: initial.startedAt,
    } } });
    const backoff = snapshot(f.wrapper);
    expect(backoff).toMatchObject({ state: { isStreaming: true, runState: {
      id: initial.id, startedAt: initial.startedAt, retry: { attempt: 1, maxAttempts: 1, retryAt: expect.any(Number) },
    } } });
    expect(backoff.state.runState!.retry!.retryAt).toBeGreaterThan(initial.startedAt);
    await vi.waitFor(() => expect(f.requests).toHaveLength(2));
    const resumed = snapshot(f.wrapper);
    expect(resumed).toMatchObject({ state: { isStreaming: true, runState: { id: initial.id, startedAt: initial.startedAt } } });
    expect(f.observed.filter(item => item.event.type === "agent_start").map(item => item.event.runState))
      .toMatchObject([{ id: initial.id, startedAt: initial.startedAt }, { id: initial.id, startedAt: initial.startedAt }]);
    f.release(1); await running;
    expect(f.sdkEvents.filter(event => ["agent_start", "agent_end", "auto_retry_start", "auto_retry_end"].includes(event.type))
      .map(event => event.type)).toEqual(["agent_start", "agent_end", "auto_retry_start", "agent_start", "auto_retry_end", "agent_end"]);
    expect(f.session.messages.filter(message => message.role === "user")).toHaveLength(1);
    expect(snapshot(f.wrapper)).toMatchObject({ state: { isStreaming: false, runState: null }, lastRunOutcome: null });
  });

  it("settles an explicit stop during backoff as stopped and never sends the scheduled retry", async () => {
    const f = await fixture([{ status: 503 }, { text: "This retry must not be requested" }], 400);
    const running = prompt(f.wrapper, "Cancel during retry backoff");
    await vi.waitFor(() => expect(f.session.isRetrying).toBe(true));
    const backoff = snapshot(f.wrapper);
    expect(backoff).toMatchObject({ state: { isStreaming: true, runState: { retry: { attempt: 1, maxAttempts: 1 } } } });
    const retryAt = backoff.state.runState!.retry!.retryAt;
    await f.wrapper.send({ type: "abort" }); await running;
    expect(f.session.isRetrying).toBe(false);
    expect(f.observed.findLast(item => item.event.type === "agent_end")?.event)
      .toMatchObject({ runOutcome: "stopped", messages: [{ role: "assistant", stopReason: "aborted" }] });
    expect(snapshot(f.wrapper)).toMatchObject({ state: { isStreaming: false, runState: null }, lastRunOutcome: "stopped" });
    // Cross the original deadline to prove the cancelled backoff cannot launch another request.
    await new Promise(resolve => setTimeout(resolve, Math.max(0, retryAt - Date.now()) + 30));
    expect(f.requests).toHaveLength(1);
    expect(f.sdkEvents.filter(event => event.type === "auto_retry_end"))
      .toMatchObject([{ success: false, finalError: "Retry cancelled" }]);
  });
});
