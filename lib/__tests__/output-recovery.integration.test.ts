import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSessionServices, createAgentSessionFromServices, ModelRuntime, SessionManager, SettingsManager, initTheme, type AgentSession, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { createOutputRecoveryExtension, OUTPUT_RECOVERY_ENTRY } from "../output-recovery-extension";
import { WORKFLOW_ENTRY, emptyWorkflow } from "../workflow-state";

const roots: string[] = [], sessions: AgentSession[] = [], servers: Server[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
interface Part { text?: string; thinking?: string; output: number; finish: string }
async function fixture(parts: Part[], extra: InlineExtension[] = [], holdFirst = false) {
  const root = mkdtempSync(join(tmpdir(), "pi-answer-recovery-")); roots.push(root);
  const cwd = join(root, "project"), agentDir = join(root, "agent"); mkdirSync(cwd); mkdirSync(agentDir);
  const requests: Array<Record<string, unknown>> = [];
  let releaseFirst!: () => void;
  const firstReady = new Promise<void>(resolve => { releaseFirst = resolve; });
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body); requests.push(input);
    if (holdFirst && requests.length === 1) await firstReady;
    const part = parts[requests.length - 1];
    if (!part) { response.writeHead(500); response.end("Unexpected extra request"); return; }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = (delta: object, finish: string | null = null, usage?: object) => `data: ${JSON.stringify({ id: "offline", object: "chat.completion.chunk", created: 1, model: "offline", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
    response.end(frame({ role: "assistant", ...(part.text ? { content: part.text } : {}), ...(part.thinking ? { reasoning_content: part.thinking } : {}) })
      + frame({}, part.finish, { prompt_tokens: 10, completion_tokens: part.output, total_tokens: 10 + part.output }) + "data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); servers.push(server);
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing local fixture address");
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { "answer-fixture": {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "local-fixture-only",
    models: [{ id: "offline", name: "Offline", reasoning: true, input: ["text"], contextWindow: 32768, maxTokens: 64,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null },
      compat: { supportsReasoningEffort: true, maxTokensField: "max_completion_tokens" } }] } } }));
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false });
  const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [createOutputRecoveryExtension(), ...extra] } });
  expect(services.resourceLoader.getExtensions().errors).toEqual([]); initTheme("dark", false);
  const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.create(cwd, join(root, "sessions")), model: modelRuntime.getModel("answer-fixture", "offline"), thinkingLevel: "high", tools: [] }); sessions.push(session);
  const events: string[] = []; session.subscribe(event => events.push(event.type));
  return { session, requests, events, releaseFirst };
}

describe("answer continuation through the real Pi SDK and loopback SSE provider", () => {
  it("finishes reasoning-only exhaustion with one logical run, a supported lower effort, and no duplicate user prompt", async () => {
    const f = await fixture([{ thinking: "private reasoning", output: 64, finish: "length" }, { text: "Complete answer", output: 8, finish: "stop" }]);
    await f.session.prompt("Answer this question");
    expect(f.requests).toHaveLength(2);
    expect(f.requests.map(request => request.reasoning_effort)).toEqual(["high", "low"]);
    expect(f.events.filter(type => type === "agent_start")).toHaveLength(1);
    expect(f.events.filter(type => type === "agent_end")).toHaveLength(1);
    expect(f.session.messages.filter(message => message.role === "user")).toHaveLength(1);
    expect(f.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Complete answer" }] });
    expect(f.session.sessionManager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === OUTPUT_RECOVERY_ENTRY)).toMatchObject([{ display: false }]);
    expect(f.session.thinkingLevel).toBe("high");
  });
  it("automatically obtains a visible answer from a normal empty stop too", async () => {
    const f = await fixture([{ output: 0, finish: "stop" }, { text: "Visible answer", output: 8, finish: "stop" }]);
    await f.session.prompt("Do not finish empty");
    expect(f.requests).toHaveLength(2);
    expect(f.session.messages.at(-1)).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "Visible answer" }] });
  });
  it("gives queued user input priority over automatic answer continuation", async () => {
    const f = await fixture([{ text: "Partial old answer", output: 64, finish: "length" }, { text: "Answer to new input", output: 8, finish: "stop" }], [], true);
    const running = f.session.prompt("Original question");
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    await f.session.followUp("New user instruction"); f.releaseFirst(); await running;
    expect(f.requests).toHaveLength(2);
    expect(f.session.sessionManager.getEntries().some(entry => entry.type === "custom_message" && entry.customType === OUTPUT_RECOVERY_ENTRY)).toBe(false);
    expect(f.session.messages.filter(message => message.role === "user")).toHaveLength(2);
  });
  it("continues multiple distinct answer chunks until the model actually completes", async () => {
    const f = await fixture([1, 2, 3].map(i => ({ text: `Part ${i}`, output: 64, finish: "length" })).concat([{ text: "Final answer", output: 8, finish: "stop" }]));
    await f.session.prompt("Give the whole answer");
    expect(f.requests).toHaveLength(4);
    expect(f.events.filter(type => type === "agent_end")).toHaveLength(1);
    expect(f.session.messages.filter(message => message.role === "assistant")).toHaveLength(4);
    expect(f.session.messages.at(-1)).toMatchObject({ stopReason: "stop" });
  });
  it("does not loop on a provider returning no answer again", async () => {
    const f = await fixture([{ thinking: "first", output: 64, finish: "length" }, { thinking: "still none", output: 64, finish: "length" }]);
    await f.session.prompt("Answer now");
    expect(f.requests).toHaveLength(2);
    expect(f.session.messages.at(-1)).toMatchObject({ stopReason: "length" });
  });
  it("lets an explicit exhausted Goal budget stop the next model request", async () => {
    const f = await fixture([{ text: "Partial", output: 64, finish: "length" }]);
    f.session.sessionManager.appendCustomEntry(WORKFLOW_ENTRY, { ...emptyWorkflow(), goal: { id: "budget", objective: "Answer", status: "budget_limited", tokens: 10, tokenBudget: 10, automaticRuns: 0 } });
    await f.session.prompt("Respect my budget");
    expect(f.requests).toHaveLength(1);
  });
  it("honors a stop after the continuation boundary without making another provider request", async () => {
    const stop: InlineExtension = { name: "fixture-stop", factory(pi) { pi.on("turn_end", (event, ctx) => {
      if (event.entries.some(entry => entry.type === "custom_message" && entry.customType === OUTPUT_RECOVERY_ENTRY)) ctx.abort();
    }); } };
    const f = await fixture([{ text: "Partial", output: 64, finish: "length" }], [stop]);
    await f.session.prompt("Stop before the next chunk");
    expect(f.requests).toHaveLength(1);
    expect(f.session.isStreaming).toBe(false);
  });
});
