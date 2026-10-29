import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Type } from "typebox";
import {
  createAgentSessionServices, createAgentSessionFromServices, defineTool, ModelRuntime,
  SessionManager, SettingsManager, initTheme, type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { AgentSessionWrapper, type AgentEvent } from "../rpc-manager";
import type { AgentSessionLike } from "../pi-types";
import { TASK_RESUME_ENTRY } from "../task-resume";
import * as gitSnapshot from "../git-snapshot";

// All storage and provider traffic are confined to disposable directories and
// an ephemeral loopback listener. No real provider/auth stores are consulted.
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
  finish?: string;
  status?: number;
  hold?: "before" | "after_delta";
}
function track<T>(promise: Promise<T>): Promise<T> {
  running.push(promise);
  // Cleanup also awaits rejected commands without creating unhandled rejections.
  void promise.catch(() => {});
  return promise;
}
function prompt(wrapper: AgentSessionWrapper, message = "Finish this task using the saved work") {
  return track(wrapper.send({ type: "prompt", message, awaitCompletion: true }));
}
function resume(wrapper: AgentSessionWrapper, requestId: string, expectedLeafId?: string) {
  return track(wrapper.send({ type: "resume", requestId, awaitCompletion: true,
    ...(expectedLeafId === undefined ? {} : { expectedLeafId }) }));
}
function receipts(session: AgentSession) {
  return session.sessionManager.getEntries().filter(entry => entry.type === "custom_message")
    .filter(entry => entry.customType === TASK_RESUME_ENTRY);
}

async function fixture(parts: ResponsePart[], snapshotCwd = false) {
  const root = mkdtempSync(join(tmpdir(), "pi-task-resume-")); roots.push(root);
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
    if (!part) { response.writeHead(500); response.end("Unexpected extra fixture request"); return; }
    if (part.hold === "before") await gates[index].ready;
    if (part.status) {
      response.writeHead(part.status, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Offline fixture unavailable", type: "server_error" } }));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = (delta: object, finish: string | null = null, usage?: object) => `data: ${JSON.stringify({
      id: "offline", object: "chat.completion.chunk", created: 1, model: "offline",
      choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}),
    })}\n\n`;
    response.write(frame({ role: "assistant", ...(part.text ? { content: part.text } : {}),
      ...(part.thinking ? { reasoning_content: part.thinking } : {}),
      ...(part.tool ? { tool_calls: [{ index: 0, id: "once-call", type: "function",
        function: { name: "fixture_once", arguments: "{}" } }] } : {}),
    }));
    if (part.hold === "after_delta") await gates[index].ready;
    response.end(frame({}, part.finish ?? (part.tool ? "tool_calls" : "stop"),
      { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 }) + "data: [DONE]\n\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
  }); servers.push(server);
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture address");
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { "resume-fixture": {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "local-fixture-only",
    models: [{ id: "offline", name: "Offline", reasoning: true, input: ["text"], contextWindow: 32768, maxTokens: 256,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  let toolExecutions = 0;
  const tool = defineTool({ name: "fixture_once", label: "Fixture once", description: "Return already completed fixture work",
    parameters: Type.Object({}), async execute() {
      toolExecutions++;
      return { content: [{ type: "text", text: "SAVED_TOOL_RESULT_42" }], details: { completed: true } };
    } });
  async function open(sessionManager: SessionManager) {
    const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: {
        enabled: false, provider: { maxRetries: 0 },
      } }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
    });
    expect(services.resourceLoader.getExtensions().errors).toEqual([]); initTheme("dark", false);
    const { session } = await createAgentSessionFromServices({ services, sessionManager,
      model: modelRuntime.getModel("resume-fixture", "offline"), thinkingLevel: "off",
      tools: ["fixture_once"], customTools: [tool],
    });
    const wrapper = new AgentSessionWrapper(session as unknown as AgentSessionLike, snapshotCwd ? cwd : "");
    wrappers.push(wrapper);
    const events: AgentEvent[] = []; wrapper.onEvent(event => events.push(event as AgentEvent)); wrapper.start();
    return { session, wrapper, events };
  }
  const initial = await open(SessionManager.create(cwd, join(root, "sessions")));
  return { ...initial, requests, toolExecutions: () => toolExecutions,
    release: (index: number) => gates[index].release(),
    async reopen(session: AgentSession, wrapper: AgentSessionWrapper) {
      const sessionFile = session.sessionFile;
      if (!sessionFile) throw new Error("Expected a persisted fixture session");
      wrapper.destroy(); wrappers.splice(wrappers.indexOf(wrapper), 1);
      return open(SessionManager.open(sessionFile));
    },
  };
}

describe("manual task resume through the real Pi SDK and loopback SSE provider", () => {
  it("retains completed tool results on the same branch and never replays the original request or tool action", async () => {
    const f = await fixture([{ tool: true }, { status: 503 }, { text: "Finished from SAVED_TOOL_RESULT_42" }]);
    await prompt(f.wrapper);
    expect(f.toolExecutions()).toBe(1);
    expect(f.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
    const leaf = f.session.sessionManager.getLeafId()!;
    const before = f.session.sessionManager.getBranch().map(entry => entry.id);
    const sendCustomMessage = vi.spyOn(f.session, "sendCustomMessage");
    const userPrompt = vi.spyOn(f.session, "prompt");
    const navigate = vi.spyOn(f.session, "navigateTree");
    await expect(resume(f.wrapper, "resume-tool", leaf)).resolves.toMatchObject({ accepted: true });
    expect(sendCustomMessage).toHaveBeenCalledWith(expect.objectContaining({
      customType: TASK_RESUME_ENTRY, display: false, details: expect.objectContaining({ requestId: "resume-tool", sourceEntryId: leaf }),
    }), { triggerTurn: true });
    expect(userPrompt).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled();
    expect(f.toolExecutions()).toBe(1);
    expect(f.requests).toHaveLength(3);
    expect(f.requests[2].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool", tool_call_id: "once-call", content: "SAVED_TOOL_RESULT_42" }),
    ]));
    expect(f.session.sessionManager.getBranch().slice(0, before.length).map(entry => entry.id)).toEqual(before);
    expect(f.session.messages.filter(message => message.role === "user")).toHaveLength(1);
    expect(f.session.messages.filter(message => message.role === "toolResult")).toHaveLength(1);
    expect(receipts(f.session)).toHaveLength(1);
    expect(f.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop",
      content: [{ type: "text", text: "Finished from SAVED_TOOL_RESULT_42" }] });
  });

  it("recovers visible text from an aborted streamed response while keeping private thinking out of resume context", async () => {
    const f = await fixture([{ text: "ABORTED_VISIBLE_PROGRESS", thinking: "PRIVATE_ABORT_THINKING", hold: "after_delta" },
      { text: "Completed after explicit stop" }]);
    const original = prompt(f.wrapper);
    await vi.waitFor(() => expect(f.events.some(event => event.type === "message_update"
      && JSON.stringify(event).includes("ABORTED_VISIBLE_PROGRESS"))).toBe(true));
    await f.wrapper.send({ type: "abort" }); await original; f.release(0);
    expect(f.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
    const originalEntries = f.session.sessionManager.getBranch();
    await resume(f.wrapper, "resume-aborted");
    const receipt = receipts(f.session)[0];
    expect(receipt.content).toContain("ABORTED_VISIBLE_PROGRESS");
    expect(receipt.content).not.toContain("PRIVATE_ABORT_THINKING");
    expect(JSON.stringify(f.requests[1])).toContain("ABORTED_VISIBLE_PROGRESS");
    expect(JSON.stringify(f.requests[1])).not.toContain("PRIVATE_ABORT_THINKING");
    expect(f.session.sessionManager.getBranch().slice(0, originalEntries.length)).toEqual(originalEntries);
    expect(f.session.messages.filter(message => message.role === "user")).toHaveLength(1);
  });

  it("recovers only visible error partials that Pi would omit from the next provider request", async () => {
    const f = await fixture([{ text: "ERROR_VISIBLE_PROGRESS", thinking: "PRIVATE_ERROR_THINKING", finish: "network_error" },
      { text: "Completed after provider error" }]);
    await prompt(f.wrapper);
    expect(f.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
    expect(JSON.stringify(f.session.messages.at(-1))).toContain("PRIVATE_ERROR_THINKING");
    await resume(f.wrapper, "resume-error");
    expect(receipts(f.session)[0].content).toContain("ERROR_VISIBLE_PROGRESS");
    expect(receipts(f.session)[0].content).not.toContain("PRIVATE_ERROR_THINKING");
    expect(JSON.stringify(f.requests[1])).toContain("ERROR_VISIBLE_PROGRESS");
    expect(JSON.stringify(f.requests[1])).not.toContain("PRIVATE_ERROR_THINKING");
    expect(f.requests).toHaveLength(2);
  });

  it("recovers saved work after reopening the JSONL session and persists request deduplication across another reopen", async () => {
    const f = await fixture([{ tool: true }, { status: 503 }, { text: "Recovered after process restart" }]);
    await prompt(f.wrapper);
    const file = f.session.sessionFile!;
    const leaf = f.session.sessionManager.getLeafId()!;
    const reopened = await f.reopen(f.session, f.wrapper);
    expect(reopened.session.sessionManager.getLeafId()).toBe(leaf);
    expect(reopened.session.messages.some(message => message.role === "toolResult")).toBe(true);
    await resume(reopened.wrapper, "durable-resume", leaf);
    const serialized = readFileSync(file, "utf8");
    expect(serialized).toContain(TASK_RESUME_ENTRY);
    expect(serialized).toContain("durable-resume");
    const again = await f.reopen(reopened.session, reopened.wrapper);
    await expect(resume(again.wrapper, "durable-resume")).resolves.toMatchObject({ accepted: true });
    expect(receipts(again.session)).toHaveLength(1);
    expect(again.session.messages.filter(message => message.role === "user")).toHaveLength(1);
    expect(f.requests).toHaveLength(3); expect(f.toolExecutions()).toBe(1);
    await expect(resume(again.wrapper, "new-request-after-completion")).rejects.toThrow(/already finished/i);
    expect(f.requests).toHaveLength(3);
  });

  it("deduplicates simultaneous and repeated requests, and rejects a separate request while recovery is running", async () => {
    const f = await fixture([{ status: 503 }, { text: "One resumed answer", hold: "before" }]);
    await prompt(f.wrapper);
    const first = resume(f.wrapper, "same-resume");
    const duplicate = resume(f.wrapper, "same-resume");
    await vi.waitFor(() => expect(f.requests).toHaveLength(2));
    await expect(resume(f.wrapper, "different-resume")).rejects.toThrow(/current activity/i);
    expect(receipts(f.session)).toHaveLength(1);
    expect(f.events.find(event => event.type === "task_resume_started")).toMatchObject({
      runState: { continuing: true },
    });
    expect(f.events.filter(event => ["message_start", "message_update", "message_end"].includes(event.type))
      .some(event => (event.message as { customType?: string } | undefined)?.customType === TASK_RESUME_ENTRY)).toBe(false);
    expect(f.wrapper.getStreamSnapshot()).toMatchObject({ state: { runState: { continuing: true } } });
    f.release(1);
    await expect(first).resolves.toMatchObject({ accepted: true });
    await expect(duplicate).resolves.toMatchObject({ accepted: true });
    await expect(resume(f.wrapper, "same-resume")).resolves.toMatchObject({ accepted: true });
    expect(f.requests).toHaveLength(2); expect(receipts(f.session)).toHaveLength(1);
  });

  it("rejects stale leaves, compaction and missing models without writing a resume receipt or launching a provider request", async () => {
    const f = await fixture([{ status: 503 }]);
    await prompt(f.wrapper);
    const leaf = f.session.sessionManager.getLeafId();
    await expect(resume(f.wrapper, "stale-leaf", "old-leaf")).rejects.toThrow(/conversation changed/i);
    const compacting = vi.spyOn(f.session, "isCompacting", "get").mockReturnValue(true);
    await expect(resume(f.wrapper, "compacting")).rejects.toThrow(/current activity/i);
    compacting.mockRestore();
    const model = vi.spyOn(f.session, "model", "get").mockReturnValue(undefined);
    await expect(resume(f.wrapper, "missing-model")).rejects.toThrow(/select a model/i);
    model.mockRestore();
    expect(f.session.sessionManager.getLeafId()).toBe(leaf);
    expect(receipts(f.session)).toHaveLength(0); expect(f.requests).toHaveLength(1);
  });

  it("honors Stop while the pre-resume snapshot is pending before the SDK can append or run recovery", async () => {
    const capture = vi.spyOn(gitSnapshot, "createSnapshot").mockResolvedValue(null);
    const f = await fixture([{ status: 503 }], true);
    await prompt(f.wrapper);
    let release!: () => void;
    const gate = new Promise<null>(resolve => { release = () => resolve(null); }); releases.push(release);
    capture.mockReturnValueOnce(gate);
    const leaf = f.session.sessionManager.getLeafId();
    const resumed = resume(f.wrapper, "stop-before-resume");
    await vi.waitFor(() => expect(capture).toHaveBeenLastCalledWith(expect.any(String), f.session.sessionId, "Before task resume"));
    await f.wrapper.send({ type: "abort" }); release();
    await expect(resumed).rejects.toThrow(/cancelled/i);
    expect(f.session.sessionManager.getLeafId()).toBe(leaf);
    expect(receipts(f.session)).toHaveLength(0); expect(f.requests).toHaveLength(1);
  });
});
