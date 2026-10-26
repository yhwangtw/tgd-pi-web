import { afterEach, afterAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSessionServices, createAgentSessionFromServices, initTheme, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { createUpstreamSubagentExtension, listUpstreamSubagentHosts, hasUpstreamSubagentWork } from "../upstream-subagents";
import { bindWebExtensions } from "../pi-runtime";
import { toEnumerableExtensionUIContext, WebExtensionUIBridge } from "../web-extension-ui";

// Every writable path is explicitly rooted in a newly created disposable folder.
const agentDir = mkdtempSync(join(tmpdir(), "pi-upstream-test-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
const sessions: AgentSession[] = [];
const servers: Server[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  rmSync(join(agentDir, "agent-runs.json"), { force: true });
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
afterAll(() => rmSync(agentDir, { recursive: true, force: true }));

async function fixture(waitForParallelPair = false) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-upstream-fixture-")); directories.push(cwd);
  mkdirSync(join(agentDir, "extensions/subagent"), { recursive: true });
  writeFileSync(join(agentDir, "extensions/subagent/config.json"), JSON.stringify({ toolActivation: "eager", asyncWidget: false }));
  const requests: string[] = [];
  let active = 0, peak = 0;
  let releasePair!: () => void;
  const pairReady = new Promise<void>(resolve => { releasePair = resolve; });
  const server = createServer(async (req, res) => {
    let body = ""; for await (const part of req) body += part;
    requests.push(body); active++; peak = Math.max(peak, active);
    if (waitForParallelPair) {
      // Wait for both children instead of assuming process startup overlaps an
      // 80 ms model response on every CI runner. Serial execution still fails.
      if (requests.length >= 2) releasePair();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([pairReady, new Promise<void>(resolve => { timer = setTimeout(resolve, 15_000); })]);
      if (timer) clearTimeout(timer);
    }
    await new Promise(resolve => setTimeout(resolve, body.includes("WAIT_FIXTURE") ? 1500 : 80));
    active--;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "offline", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const input = JSON.parse(body);
    if (body.includes("PARENT_DELEGATE") && input.tools?.some((tool: { function?: { name?: string } }) => tool.function?.name === "subagent") && !input.messages.some((message: { role: string }) => message.role === "tool")) {
      res.end(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "fixture-call", type: "function", function: { name: "subagent", arguments: JSON.stringify({ agent: "worker", task: "SDK_CHILD", async: false, context: "fresh", model: "fixture/offline" }) } }] }) + chunk({}, "tool_calls") + "data: [DONE]\n\n");
    } else res.end(chunk({ role: "assistant", content: "CHILD_DONE" }) + chunk({}, "stop") + "data: [DONE]\n\n");
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); servers.push(server);
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No local fixture port");
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "local-test-only", models: [{ id: "offline", name: "Offline", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096 }] } } }));
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime, settingsManager: SettingsManager.inMemory(), resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [createUpstreamSubagentExtension()] } });
  expect(services.resourceLoader.getExtensions().errors).toEqual([]);
  initTheme("dark", false);
  const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.create(cwd, join(cwd, "sessions")), model: modelRuntime.getModel("fixture", "offline") });
  sessions.push(session);
  const errors: unknown[] = [];
  await bindWebExtensions(session, e => errors.push(e), toEnumerableExtensionUIContext(new WebExtensionUIBridge({ theme: session.extensionRunner.getUIContext().theme })));
  expect(errors).toEqual([]);
  const host = listUpstreamSubagentHosts().find(item => item.sessionId === session.sessionId)!;
  expect(host).toBeDefined();
  const tool = session.extensionRunner.getAllRegisteredTools().find(item => item.definition.name === "subagent")!.definition;
  return { session, services, modelRuntime, host, requests, errors, cwd, peak: () => peak,
    call: (args: Record<string, unknown>) => tool.execute(crypto.randomUUID(), args, new AbortController().signal, undefined, session.extensionRunner.createToolContext("fixture", new AbortController().signal)) };
}

describe("pinned upstream pi-subagents running through the real SDK", () => {
  it("loads real tools/RPC and runs foreground children in parallel with isolated sessions", async () => {
    const f = await fixture(true);
    expect(f.session.getActiveToolNames()).toContain("subagent");
    const ping = await f.host.client.request<{ capabilities: { asyncSpawn: boolean } }>("ping");
    expect(ping.capabilities.asyncSpawn).toBe(true);
    const result = await f.call({ workflow: "parallel", args: { tasks: [{ agent: "worker", task: "FIRST_FIXTURE", model: "fixture/offline" }, { agent: "worker", task: "SECOND_FIXTURE", model: "fixture/offline" }] }, async: false, context: "fresh" });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(JSON.stringify(result)).toContain("CHILD_DONE");
    expect(f.requests).toHaveLength(2);
    expect(f.peak()).toBe(2);
    expect(f.errors).toEqual([]);
  }, 60_000);
  it("starts a real background runner, retains its parent and accepts a scoped stop", async () => {
    const f = await fixture();
    const started = await f.host.client.request("spawn", { agent: "worker", task: "WAIT_FIXTURE", model: "fixture/offline", context: "fresh" });
    expect(JSON.stringify(started)).toContain("asyncId");
    type Status = { asyncSnapshot: { runs: Array<{ id: string; state: string }> } };
    let runId = "";
    await vi.waitFor(async () => {
      const status = await f.host.client.request<Status>("status");
      runId = status.asyncSnapshot.runs[0]?.id;
      expect(runId).toBeTruthy();
      expect(hasUpstreamSubagentWork(f.session.sessionId)).toBe(true);
    }, { timeout: 10_000 });
    await f.host.client.request("stop", { id: runId });
    await vi.waitFor(async () => {
      const status = await f.host.client.request<Status>("status");
      expect(status.asyncSnapshot.runs.find(run => run.id === runId)?.state).toBe("stopped");
    }, { timeout: 10_000 });
    await expect(f.host.client.request("resume", { id: runId, message: "FOLLOWUP_FIXTURE" })).rejects.toThrow("was stopped");
    await f.host.client.request("spawn", { agent: "worker", task: "FOLLOWUP_FIXTURE", model: "fixture/offline", context: "fresh" });
    await vi.waitFor(() => expect(f.requests.some(request => request.includes("FOLLOWUP_FIXTURE"))).toBe(true), { timeout: 20_000 });
    await vi.waitFor(() => expect(f.session.messages.some(message => message.role === "assistant")).toBe(true), { timeout: 20_000 });
  }, 60_000);

  it("keeps narrowed parent tools and refuses to silently drop saved limits", async () => {
    const f = await fixture();
    f.session.setActiveToolsByName(["read", "subagent"]);
    await f.call({ agent: "worker", task: "READ_ONLY_FIXTURE", async: false, model: "fixture/offline", context: "fresh" });
    const offered = JSON.parse(f.requests[0]).tools.map((tool: { function: { name: string } }) => tool.function.name);
    expect(offered).not.toContain("bash");
    expect(offered).not.toContain("write");
    expect(offered).not.toContain("edit");
    writeFileSync(join(agentDir, "agent-runs.json"), JSON.stringify({ version: 1, runs: [], subagentLimits: { maxCostUsd: 1 } }));
    expect(() => f.call({ agent: "worker", task: "BLOCKED_FIXTURE" })).toThrow("Saved Pi Web subagent limits");
    expect(() => f.host.client.request("spawn", { agent: "worker", task: "BLOCKED_FIXTURE" })).toThrow("Saved Pi Web subagent limits");
    expect(f.requests).toHaveLength(1);
    await expect(f.host.client.request("status")).resolves.toBeDefined();
  }, 60_000);

  it("lets the SDK parent delegate through the actual upstream tool and export usable fork context", async () => {
    const f = await fixture();
    await f.session.prompt("PARENT_DELEGATE");
    const toolResult = f.session.messages.find(message => message.role === "toolResult");
    expect(toolResult, JSON.stringify(f.session.messages)).toMatchObject({ role: "toolResult", isError: false });
    expect(JSON.stringify(toolResult)).toContain("CHILD_DONE");
    const ping = await f.host.client.request<{ session: { sessionFile: string } }>("ping");
    expect(readFileSync(ping.session.sessionFile, "utf8")).toContain("PARENT_DELEGATE");
    expect(SessionManager.open(ping.session.sessionFile).getSessionId()).toBe(f.session.sessionId);
    const forked = await f.call({ agent: "worker", task: "FORK_FIXTURE", async: false, context: "fork", model: "fixture/offline" });
    expect(forked.isError, JSON.stringify(forked)).not.toBe(true);
    expect(f.requests.at(-1)).toContain("PARENT_DELEGATE");
    expect(f.requests.at(-1)).toContain("FORK_FIXTURE");
    expect(f.errors).toEqual([]);
  }, 60_000);
});
