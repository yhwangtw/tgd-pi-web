import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai-durable";
import type { HarnessOptions } from "@earendil-works/pi-durable";
import { createDurableChat, getDurableChat, type DurableChat } from "../durable-chat";
import { durableSessionDirectory, readDurableProjection } from "../durable-session-store";
import { resolveSessionPath } from "../session-reader";
import { POST as send, GET as state } from "@/app/api/agent/[id]/route";
import { GET as events } from "@/app/api/agent/[id]/events/route";
import { GET as detail, PATCH as rename, DELETE as remove } from "@/app/api/sessions/[id]/route";
import { GET as context } from "@/app/api/sessions/[id]/context/route";
import { POST as clone } from "@/app/api/sessions/[id]/clone/route";
import { GET as markdown } from "@/app/api/sessions/[id]/export-md/route";
import { GET as html } from "@/app/api/sessions/[id]/export/route";
import { GET as list } from "@/app/api/sessions/route";
import { GET as search } from "@/app/api/sessions/search/route";
import { GET as analytics } from "@/app/api/sessions/analytics/route";
import { GET as semantic } from "@/app/api/search/semantic/route";
import { POST as command } from "@/app/api/agent/[id]/command/route";
import { readDurableWorkflow } from "../durable-workflow";
import { collectAttentionItems } from "../attention-center";

const chats: DurableChat[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const chat of chats.splice(0)) await chat.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-durable-route-")); roots.push(cwd);
  const faux = fauxProvider({ provider: "route-fixture", models: [{ id: "model" }], tokensPerSecond: 0 });
  const models = createModels(); models.setProvider(faux.provider);
  const chat = await createDurableChat({ cwd, provider: "route-fixture", modelId: "model", models: models as unknown as HarnessOptions["models"],
    settings: { compaction: { enabled: false }, retry: { enabled: false } } });
  chats.push(chat);
  const directory = durableSessionDirectory(chat.sessionId.split("_")[1]); roots.push(directory);
  return { chat, faux, directory, params: { params: Promise.resolve({ id: chat.sessionId }) } };
}
function request(path = "", body?: unknown, key?: string) {
  return new Request(`http://localhost${path || "/"}`, body === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) }, body: JSON.stringify(body),
  });
}
function directoryBytes(directory: string): Record<string, string> {
  return Object.fromEntries(readdirSync(directory).filter(name => !name.endsWith(".lock")).map(name => [name, readFileSync(join(directory, name)).toString("base64")]));
}

describe("Durable session API integration with real SQLite and an offline provider", () => {
  it("dispatches native workflow commands without invoking a model and rejects unknown commands", async () => {
    const { chat, faux, params } = await fixture();
    expect((await command(request("/", { command: "plan", args: "on" }), params)).status).toBe(200);
    expect((await readDurableWorkflow(chat.harness, chat.conversation.id)).plan?.status).toBe("planning");
    expect((await command(request("/", { command: "not-an-extension" }), params)).status).toBe(404);
    expect(faux.state.callCount).toBe(0);
  });

  it("includes a persisted native model failure in the attention inbox without reopening the agent", async () => {
    const { chat, faux } = await fixture();
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "Route provider failed" })]);
    await expect(chat.send({ type: "prompt", message: "Fail once", awaitCompletion: true })).rejects.toThrow("did not complete");
    await chat.send({ type: "get_state" });
    await chat.close();
    expect(await collectAttentionItems()).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: chat.sessionId, status: "failed", summary: "Route provider failed" }),
    ]));
    expect(getDurableChat(chat.sessionId)).toBeUndefined();
    expect(faux.state.callCount).toBe(1);
  });

  it("deduplicates HTTP prompts and exposes actual saved context and reconnect events", async () => {
    const { chat, faux, params } = await fixture();
    faux.setResponses([fauxAssistantMessage("One route answer")]);
    const command = { type: "prompt", message: "One route question", awaitCompletion: true };
    expect((await send(request("/", command, "lost-http-ack"), params)).status).toBe(200);
    expect((await send(request("/", command, "lost-http-ack"), params)).status).toBe(200);
    expect(faux.state.callCount).toBe(1);
    const data = await (await detail(request("/?includeState=1"), params)).json();
    expect(data).toMatchObject({ sessionId: chat.sessionId, info: { messageCount: 2 }, agentState: { running: true } });
    expect(data.context.messages).toHaveLength(2);
    expect(data.context.messages[1].content[0].text).toBe("One route answer");
    expect(await resolveSessionPath(chat.sessionId)).toBeNull();
    const historical = await (await context(request(`/?leafId=${data.context.entryIds[0]}`), params)).json();
    expect(historical.context.messages).toHaveLength(1);
    expect((await context(request("/?leafId=99999"), params)).status).toBe(400);
    expect((await context(request(`/?leafId=${data.context.entryIds[0]}:999`), params)).status).toBe(400);
    expect(await (await state(request(), params)).json()).toMatchObject({ running: true, state: { isStreaming: false } });
    const abort = new AbortController();
    const response = await events(new Request("http://localhost/?cursor=stale:1", { signal: abort.signal }), params);
    const reader = response.body!.getReader();
    try {
      let text = "";
      while (!text.includes("session_snapshot")) {
        const chunk = await reader.read(); if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
      }
      expect(text).toContain('"type":"connected"');
      expect(text).toContain('"replayStatus":"reset"');
      expect(text).toContain("One route answer");
    } finally { abort.abort(); await reader.cancel(); }
    expect(faux.state.callCount).toBe(1);
  });

  it("reads closed sessions in list, both searches, analytics and real CLI exports without reopening or changing storage", async () => {
    const { chat, faux, directory, params } = await fixture();
    faux.setResponses([fauxAssistantMessage("Neutrino migration answer API_KEY=fixture-secret-123")]);
    await chat.send({ type: "prompt", message: "Neutrino migration question", awaitCompletion: true });
    await chat.rename("Neutrino migration");
    await chat.close();
    const before = directoryBytes(directory);
    expect((await (await list()).json()).sessions).toEqual(expect.arrayContaining([expect.objectContaining({ id: chat.sessionId })]));
    expect(await (await detail(request("/?includeState=1"), params)).json()).toMatchObject({ agentState: { running: false } });
    expect(await (await state(request(), params)).json()).toEqual({ running: false });
    expect((await (await search(request("/?q=Neutrino"))).json()).hits).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: chat.sessionId, provider: "route-fixture", modelId: "model", matches: expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("Neutrino") })]) }),
    ]));
    expect((await (await semantic(request("/?q=Neutrino%20migration"))).json()).hits).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: chat.sessionId })]));
    const report = await (await analytics()).json();
    expect(report.perSession).toEqual(expect.arrayContaining([expect.objectContaining({ id: chat.sessionId, messageCount: 2 })]));
    const md = await markdown(request(), params);
    expect(md.status).toBe(200);
    const exportedMarkdown = await md.text();
    expect(exportedMarkdown).toContain("Neutrino migration answer");
    expect(exportedMarkdown).not.toContain("fixture-secret-123");
    const exported = await html(request(), params);
    expect(exported.status).toBe(200);
    const page = await exported.text();
    const payload = page.match(/<script[^>]+id="session-data"[^>]*>([^<]+)<\/script>/)?.[1];
    expect(payload).toBeTruthy();
    const exportedHistory = Buffer.from(payload!, "base64").toString("utf8");
    expect(exportedHistory).toContain("Neutrino migration answer");
    expect(exportedHistory).toContain("[REDACTED]");
    expect(exportedHistory).not.toContain("fixture-secret-123");
    expect(getDurableChat(chat.sessionId)).toBeUndefined();
    expect(faux.state.callCount).toBe(1);
    expect(directoryBytes(directory)).toEqual(before);
  });

  it("renames and clones actual persisted history and deletes the selected branch only", async () => {
    const { chat, faux, params } = await fixture();
    faux.setResponses([fauxAssistantMessage("Preserved parent answer")]);
    await chat.send({ type: "prompt", message: "Parent question", awaitCompletion: true });
    expect((await rename(request("/", { name: "Renamed through API" }), params)).status).toBe(200);
    expect(readDurableProjection(chat.sessionId)?.info.name).toBe("Renamed through API");
    const forkResponse = await clone(request(), params);
    expect(forkResponse.status).toBe(201);
    const fork = await forkResponse.json();
    expect(fork.sessionId).not.toBe(chat.sessionId);
    const forkParams = { params: Promise.resolve({ id: fork.sessionId }) };
    const forkData = await (await detail(request(), forkParams)).json();
    expect(forkData.info.parentSessionId).toBe(chat.sessionId);
    expect(forkData.context.messages.at(-1).content[0].text).toBe("Preserved parent answer");
    expect((await remove(request(), forkParams)).status).toBe(200);
    expect((await detail(request(), forkParams)).status).toBe(404);
    expect((await detail(request(), params)).status).toBe(200);
    expect(faux.state.callCount).toBe(1);
  });

  it("refuses an empty clone and does not fabricate a missing persisted projection", async () => {
    const { chat, faux, directory, params } = await fixture();
    expect((await clone(request(), params)).status).toBe(409);
    await chat.close();
    rmSync(join(directory, "1.json"));
    for (const read of [detail, context, markdown, html]) expect((await read(request(), params)).status).toBe(404);
    expect((await clone(request(), params)).status).toBe(404);
    expect((await send(request("/", { type: "get_state" }), params)).status).toBe(404);
    expect((await events(request(), params)).status).toBe(404);
    expect((await (await list()).json()).sessions.some((session: { id: string }) => session.id === chat.sessionId)).toBe(false);
    expect(getDurableChat(chat.sessionId)).toBeUndefined();
    expect(faux.state.callCount).toBe(0);
  });
});
