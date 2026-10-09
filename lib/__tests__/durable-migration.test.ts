import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai-durable";
import type { HarnessOptions } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { migrateLegacySession } from "../durable-migration";
import { createDurableChat, getDurableChat, openDurableChat, type DurableChat } from "../durable-chat";
import { durableContext, durableEntries, listDurableSessions, readDurableProjection } from "../durable-session-store";
import { durableExtensionEntries } from "../durable-extension-host";
import { legacyModel, parseLegacyArchive } from "../durable-legacy";
import { keepStandardSession, resolveMigratedSessionId } from "../session-migrations";
import { cacheSessionPath, listAllSessions } from "../session-reader";
import { readDurableWorkflow } from "../durable-workflow";
import { GET as detail, DELETE as remove } from "@/app/api/sessions/[id]/route";
import { GET as context } from "@/app/api/sessions/[id]/context/route";
import { POST as send } from "@/app/api/agent/[id]/route";
import { GET as events } from "@/app/api/agent/[id]/events/route";
import { GET as pins } from "@/app/api/sessions/pins/route";
import { GET as archive } from "@/app/api/sessions/archive/route";
import { GET as tags } from "@/app/api/sessions/tags/route";

const runtime = vi.hoisted(() => ({ live: undefined as unknown }));
vi.mock("../rpc-manager", () => ({ getRpcSession: () => runtime.live, getResumableRpcSession: () => undefined, isRpcSessionStarting: () => false }));
const chats: DurableChat[] = [];
afterEach(async () => { runtime.live = undefined; for (const chat of chats.splice(0)) await chat.close(); });
const timestamp = "2026-10-01T00:00:00.000Z";
const stamp = Date.parse(timestamp);
function fixture() {
  const id = randomUUID();
  const directory = join(getAgentDir(), "sessions", "migration-fixture"); mkdirSync(directory, { recursive: true });
  const sourcePath = join(directory, `${id}.jsonl`);
  const base = (id: string, parentId: string | null) => ({ id, parentId, timestamp });
  const files: FileEntry[] = [
    { type: "session", id, version: 3, cwd: getAgentDir(), timestamp },
    { ...base("model", null), type: "model_change", provider: "migration-fixture", modelId: "original" },
    { ...base("think", "model"), type: "thinking_level_change", thinkingLevel: "low" },
    { ...base("question", "think"), type: "message", message: { role: "user", content: "Original question", timestamp: stamp } },
    { ...base("answer-a", "question"), type: "message", message: { ...fauxAssistantMessage("Branch A", { timestamp: stamp }), provider: "migration-fixture", model: "original" } as never },
    { ...base("answer-b", "question"), type: "message", message: { ...fauxAssistantMessage("Branch B", { timestamp: stamp }), provider: "migration-fixture", model: "original" } as never },
    { ...base("workflow", "answer-a"), type: "custom", customType: "pi-web-workflow-v1", data: { version: 1,
      goal: { id: "goal", objective: "Keep my goal", status: "active", tokens: 23, tokenBudget: 1000, automaticRuns: 2 },
      plan: { title: "Keep my plan", status: "ready", steps: [{ text: "Review", status: "completed" }, { text: "Execute", status: "pending" }], previousTools: ["read"] } } },
    { ...base("hidden", "workflow"), type: "custom_message", customType: "memory", content: "Saved hidden context", display: false },
    { ...base("metadata", "hidden"), type: "custom", customType: "fixture-watermark", data: { entryId: "answer-a" } },
    { ...base("name", "metadata"), type: "session_info", name: "My original chat" },
    { ...base("label", "name"), type: "label", targetId: "answer-b", label: "Alternate" },
  ];
  const save = () => writeFileSync(sourcePath, files.map(entry => JSON.stringify(entry)).join("\n") + "\n"); save(); cacheSessionPath(id, sourcePath);
  const faux = fauxProvider({ provider: "migration-fixture", models: [{ id: "original" }], tokensPerSecond: 0 });
  const models = createModels(); models.setProvider(faux.provider);
  const options = { provider: "migration-fixture", modelId: "original", models: models as unknown as HarnessOptions["models"], settings: { compaction: { enabled: false }, retry: { enabled: false } } };
  return { id, sourcePath, files, save, faux, options, params: { params: Promise.resolve({ id }) } };
}
async function convert(f: ReturnType<typeof fixture>) {
  const result = await migrateLegacySession(f.id, f.options);
  expect(result, JSON.stringify(result)).toMatchObject({ status: "converted" });
  const chat = getDurableChat(result.sessionId)!; chats.push(chat); return chat;
}
const request = (body?: unknown) => new Request("http://localhost/", body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);

describe("automatic legacy conversion", () => {
  it("preserves bytes, every branch, IDs, hidden entries and workflow without starting a model", async () => {
    const f = fixture(); const original = readFileSync(f.sourcePath, "utf8");
    const chat = await convert(f);
    expect(f.faux.state.callCount).toBe(0);
    expect(readFileSync(f.sourcePath, "utf8")).toBe(original);
    const p = chat.getProjection();
    expect(p.info).toMatchObject({ name: "My original chat", sourceSessionId: f.id, created: timestamp });
    expect(p.context.entryIds).toEqual(["question", "answer-a", "hidden"]);
    expect(p.context.messages.at(-1)).toMatchObject({ role: "custom", display: false });
    expect(durableEntries(p.entries, timestamp).slice(0, -1)).toEqual(f.files.slice(1));
    expect(durableContext(p.entries, p.agent, "answer-b").messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "Branch B" }] });
    expect(JSON.stringify(chat.getSessionData().tree)).toContain('"label":"Alternate"');
    const sdk = SessionManager.inMemory(getAgentDir(), { id: chat.sessionId }, durableExtensionEntries(p.entries, getAgentDir(), chat.sessionId));
    expect(sdk.getEntry("metadata")).toMatchObject({ data: { entryId: "answer-a" } });
    expect(sdk.buildSessionContext().messages.at(-1)).toMatchObject({ role: "custom", display: false });
    expect(await readDurableWorkflow(chat.harness, chat.conversation.id)).toMatchObject({ goal: { status: "paused", tokens: 23, automaticRuns: 2 }, plan: { status: "ready", steps: [{ status: "completed" }, { status: "pending" }] } });
  });
  it("deduplicates concurrent conversion, continues once, reopens, and preserves old bookmarks", async () => {
    const f = fixture();
    const results = await Promise.all([migrateLegacySession(f.id, f.options), migrateLegacySession(f.id, f.options)]);
    expect(results[0].status).toBe("converted"); expect(results[0].sessionId).toBe(results[1].sessionId);
    const chat = getDurableChat(results[0].sessionId)!; chats.push(chat);
    f.faux.setResponses([ctx => { expect(JSON.stringify(ctx.messages)).toContain("Branch A"); expect(JSON.stringify(ctx.messages)).not.toContain("Branch B"); return fauxAssistantMessage("Continued once"); }]);
    const command = { type: "prompt", message: "Continue", requestId: "lost-ack", awaitCompletion: true };
    const first = await send(request(command), f.params); expect(first.status, await first.clone().text()).toBe(200);
    expect((await send(request(command), f.params)).status).toBe(200);
    expect(f.faux.state.callCount).toBe(1);
    expect((await listAllSessions()).filter(info => info.id === f.id || info.id === chat.sessionId)).toHaveLength(1);
    await chat.close();
    const reopened = await openDurableChat(chat.sessionId, { ...f.options, cwd: getAgentDir() }); chats.push(reopened);
    expect((await (await detail(request(), f.params)).json()).sessionId).toBe(chat.sessionId);
    expect(reopened.getProjection().context.entryIds.at(-1)).toMatch(/^durable:/);
    expect(reopened.getProjection().context.messages.filter(message => JSON.stringify(message).includes("Continued once"))).toHaveLength(1);
    const controller = new AbortController();
    const stream = await events(new Request("http://localhost/", { signal: controller.signal }), f.params);
    const reader = stream.body!.getReader(); let text = "";
    for (let i = 0; i < 3; i++) { const item = await reader.read(); text += new TextDecoder().decode(item.value); }
    controller.abort(); await reader.cancel();
    expect(text).toContain('"type":"session_replaced"'); expect(text).toContain(chat.sessionId);
  });
  it("forks any archived branch, and edits before an old message without mutating the source", async () => {
    const f = fixture(); const chat = await convert(f); const before = chat.getSessionData();
    const alternate = await chat.fork("answer-b");
    expect(alternate.getProjection().context.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "Branch B" }] });
    expect((await listDurableSessions()).some(info => info.id === alternate.sessionId)).toBe(true);
    const edited = await chat.fork("answer-a", true);
    expect(edited.getProjection().context.entryIds).toEqual(["question"]);
    expect(chat.getSessionData()).toEqual(before);
    const data = await (await context(new Request("http://localhost/?leafId=answer-b"), f.params)).json();
    expect(data.context.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "Branch B" }] });
  });
  it("keeps pins, tags and archives mapped, and deleting the new session never revives its source", async () => {
    const f = fixture();
    writeFileSync(join(getAgentDir(), "pins.json"), JSON.stringify({ pinned: [f.id] }));
    writeFileSync(join(getAgentDir(), "archive.json"), JSON.stringify({ archived: [f.id] }));
    writeFileSync(join(getAgentDir(), "tags.json"), JSON.stringify({ tags: { [f.id]: ["test"] } }));
    const chat = await convert(f);
    expect(await (await pins()).json()).toEqual({ pinned: [chat.sessionId] });
    expect(await (await archive()).json()).toEqual({ archived: [chat.sessionId] });
    expect(await (await tags()).json()).toEqual({ tags: { [chat.sessionId]: ["test"] } });
    expect((await remove(request(), f.params)).status).toBe(200);
    expect((await detail(request(), f.params)).status).toBe(404);
    expect(readFileSync(f.sourcePath, "utf8")).toContain(f.id);
    expect(resolveMigratedSessionId(f.id)).toBe(chat.sessionId);
    expect((await listAllSessions()).some(info => info.id === f.id || info.id === chat.sessionId)).toBe(false);
  });
  it("defers busy conversations and preserves explicit Standard selection", async () => {
    const f = fixture(); runtime.live = { migrationBusyReason: () => "Waiting for an answer" };
    expect(await migrateLegacySession(f.id, f.options)).toMatchObject({ status: "deferred", reason: "Waiting for an answer" });
    runtime.live = undefined; keepStandardSession(f.id);
    expect(await migrateLegacySession(f.id, f.options)).toMatchObject({ status: "unchanged", sessionId: f.id });
    expect(f.faux.state.callCount).toBe(0);
  });
  it.each(["truncated", "cycle", "duplicate", "future", "unpaired"])("retains the original for invalid %s history", async kind => {
    const f = fixture();
    if (kind === "truncated") writeFileSync(f.sourcePath, readFileSync(f.sourcePath, "utf8") + "{broken");
    else {
      if (kind === "cycle") (f.files[2] as { parentId: string }).parentId = "think";
      if (kind === "duplicate") (f.files[2] as { id: string }).id = "model";
      if (kind === "future") (f.files[0] as { version: number }).version = 999;
      if (kind === "unpaired") (f.files[4] as { message: unknown }).message = fauxAssistantMessage(fauxToolCall("bash", { command: "echo do-not-run" }), { stopReason: "toolUse" });
      f.save();
    }
    const source = readFileSync(f.sourcePath, "utf8");
    expect(await migrateLegacySession(f.id, f.options)).toMatchObject({ status: "deferred", sessionId: f.id });
    expect(resolveMigratedSessionId(f.id)).toBe(f.id); expect(readFileSync(f.sourcePath, "utf8")).toBe(source); expect(f.faux.state.callCount).toBe(0);
  });
  it("keeps an unpublished conversion inaccessible even after a restart", async () => {
    const f = fixture();
    const saved = parseLegacyArchive(readFileSync(f.sourcePath, "utf8"), f.id);
    const staging = await createDurableChat({ ...f.options, cwd: getAgentDir(), legacy: { archive: saved, sourceId: f.id } }); chats.push(staging);
    expect(getDurableChat(staging.sessionId)).toBeUndefined();
    expect(readDurableProjection(staging.sessionId)).toBeUndefined();
    expect(listDurableSessions().some(info => info.id === staging.sessionId)).toBe(false);
    await staging.close();
    await expect(openDurableChat(staging.sessionId, { ...f.options, cwd: getAgentDir() })).rejects.toThrow("not published");
    expect(f.faux.state.callCount).toBe(0);
  });
  it("restores the selected system instructions and exact tool selection on a cold conversion", async () => {
    const f = fixture();
    f.files.splice(3, 0, { type: "message", id: "system", parentId: "think", timestamp,
      message: { role: "system", content: "Keep these exact instructions", toolsAdded: [{ name: "read", description: "Read", parameters: { type: "object", properties: {} } }], timestamp: stamp } as never });
    (f.files[4] as { parentId: string }).parentId = "system"; f.save();
    const chat = await convert(f);
    expect(chat.getProjection().agent).toMatchObject({ instructions: "Keep these exact instructions", tools: ["read"], thinkingLevel: "low" });
    expect(chat.getProjection().context.entryIds).not.toContain("system");
    expect(f.faux.state.callCount).toBe(0);
  });
  it("does not publish or expose a candidate if its source changes before verification", async () => {
    const f = fixture();
    const original = f.options.models.getModel.bind(f.options.models);
    const get = vi.spyOn(f.options.models, "getModel").mockImplementation((...args) => {
      writeFileSync(f.sourcePath, readFileSync(f.sourcePath, "utf8") + "\n");
      return original(...args);
    });
    try {
      expect(await migrateLegacySession(f.id, f.options)).toMatchObject({ status: "deferred", reason: expect.stringContaining("changed during conversion") });
      expect(resolveMigratedSessionId(f.id)).toBe(f.id);
      expect(listDurableSessions().some(info => info.sourceSessionId === f.id)).toBe(false);
      expect(f.faux.state.callCount).toBe(0);
    } finally { get.mockRestore(); }
  });
  it("retains a source whose selected model is not available", async () => {
    const f = fixture();
    for (const entry of f.files) {
      if (entry.type === "model_change") entry.modelId = "removed";
      if (entry.type === "message" && entry.message.role === "assistant") entry.message.model = "removed";
    }
    f.save();
    expect(await migrateLegacySession(f.id, f.options)).toMatchObject({ status: "deferred", reason: expect.stringContaining("model is unavailable") });
    expect(resolveMigratedSessionId(f.id)).toBe(f.id); expect(f.faux.state.callCount).toBe(0);
  });
  it("imports compacted context with matched historical tools and never executes them", async () => {
    const f = fixture();
    f.files.splice(4);
    f.files.push({ id: "tool", parentId: "question", timestamp, type: "message", message: { ...fauxAssistantMessage(fauxToolCall("bash", { command: "echo do-not-run" }, { id: "call" }), { stopReason: "toolUse" }), provider: "migration-fixture", model: "original" } as never },
      { id: "result", parentId: "tool", timestamp, type: "message", message: { role: "toolResult", toolCallId: "call", toolName: "bash", content: [{ type: "text", text: "Saved result" }], isError: false, timestamp: stamp } },
      { id: "compact", parentId: "result", timestamp, type: "compaction", summary: "Saved summary", firstKeptEntryId: "question", tokensBefore: 1200 }); f.save();
    const expected = legacyModel(parseLegacyArchive(readFileSync(f.sourcePath, "utf8"), f.id));
    const chat = await convert(f);
    expect((await chat.conversation.entries({}, 20, undefined, BACKGROUND_CONTEXT)).items[0].model).toEqual(expected);
    expect(JSON.stringify(chat.getProjection().context)).toContain("Saved summary"); expect(f.faux.state.callCount).toBe(0);
  });
});
