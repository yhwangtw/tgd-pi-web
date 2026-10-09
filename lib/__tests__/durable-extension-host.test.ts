import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createAgentSessionServices, ModelRuntime, SettingsManager, type ExtensionUIContext, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai-durable";
import { createRegistry, Harness, type Conversation, type HarnessOptions } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createDurableExtensionHost } from "../durable-extension-host";
import { toEnumerableExtensionUIContext, WebExtensionUIBridge } from "../web-extension-ui";

const context = BACKGROUND_CONTEXT;
const directories: string[] = [];
const opened = new Set<Harness>();
afterEach(async () => {
  for (const harness of opened) await harness.close(context);
  opened.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(resources = false) {
  const directory = mkdtempSync(join(tmpdir(), "pi-durable-extensions-"));
  directories.push(directory);
  if (resources) {
    mkdirSync(join(directory, "prompts"));
    writeFileSync(join(directory, "prompts", "fixture.md"), "---\ndescription: Fixture template\n---\nTemplate $1 / ${2:-default}");
    mkdirSync(join(directory, "skills", "fixture"), { recursive: true });
    writeFileSync(join(directory, "skills", "fixture", "SKILL.md"), "---\nname: fixture\ndescription: Fixture skill\n---\nSkill body");
  }
  const faux = fauxProvider({ provider: "extension-fixture", models: [{ id: "offline" }], tokensPerSecond: 0 });
  const models = createModels(); models.setProvider(faux.provider);
  const calls = { contexts: 0, sessions: [] as string[], toolSessions: [] as string[], capture: [] as string[][], before: [] as string[], shutdown: 0, input: 0, questions: [] as string[] };
  const errors: unknown[] = [];
  const extension: InlineExtension = { name: "memory-lifecycle-fixture", factory(pi) {
    pi.on("input", event => {
      calls.input++;
      if (event.text === "Intercept this") return { action: "handled" };
      if (event.text === "Rewrite this") return { action: "transform", text: '/fixture "two words"' };
    });
    pi.on("session_start", (_event, ctx) => { calls.sessions.push(ctx.sessionManager.getSessionId()); });
    pi.on("before_agent_start", async (event, ctx) => {
      calls.before.push(ctx.sessionManager.getSessionId());
      if (event.prompt === "Question prompt") {
        await ctx.ui.input("First");
        await ctx.ui.input("Second");
      }
      pi.registerTool({ name: "memory_fixture", label: "Memory fixture", description: "An extension tool discovered before the request", parameters: Type.Object({ value: Type.String() }),
        execute: async (_id, args, _signal, _update, ctx) => {
          calls.toolSessions.push(ctx.sessionManager.getSessionId());
          return { content: [{ type: "text", text: args.value }], details: { session: ctx.sessionManager.getSessionId() } };
        },
      });
      return { systemPrompt: `${event.systemPrompt}\nMEMORY_PROFILE_FIXTURE`, ...(event.prompt === "Attach note" ? { message: { customType: "fixture-note", content: "MODEL_VISIBLE_NOTE", display: false } } : {}) };
    });
    pi.on("context", (event, ctx) => {
      calls.contexts++;
      const ids = ctx.sessionManager.buildContextEntries().filter(entry => entry.type === "message" && entry.message.role === "user").map(entry => entry.id);
      const last = event.messages.findLast(message => message.role === "user");
      if (last?.role === "user") last.content = `${typeof last.content === "string" ? last.content : "input"}\nRECALL:${ids.at(-1)}`;
      return { messages: event.messages };
    });
    pi.on("tool_call", event => {
      if (event.toolName === "memory_fixture") {
        if (event.input.value === "blocked") return { block: true, reason: "Fixture guard" };
        event.input.value = `checked:${event.input.value}`;
      }
    });
    pi.on("tool_result", event => event.toolName === "memory_fixture" ? { content: [...event.content, { type: "text", text: "RESULT_HOOK" }] } : undefined);
    pi.on("turn_end", (_event, ctx) => {
      calls.capture.push(ctx.sessionManager.getBranch().filter(entry => entry.type === "message").map(entry => entry.id));
      pi.appendEntry("fixture-capture-watermark", { entries: ctx.sessionManager.getEntries().length });
    });
    pi.on("session_shutdown", () => { calls.shutdown++; });
    pi.registerCommand("memory_status", { description: "Fixture command", handler: async (_args, ctx) => { pi.appendEntry("fixture-command", { session: ctx.sessionManager.getSessionId() }); } });
  } };
  async function open() {
    const registry = createRegistry();
    const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "session.sqlite")), {
      models: models as unknown as HarnessOptions["models"], registry,
      settings: { extensions: [], compaction: { enabled: false }, retry: { enabled: false } },
    }, context);
    opened.add(harness);
    const root = await harness.root(context, { agent: { model: { provider: "extension-fixture", modelId: "offline" } } });
    async function host(conversation: Conversation, sessionId: string) {
      const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
      runtime.registerNativeProvider(faux.provider as unknown as Parameters<typeof runtime.registerNativeProvider>[0]);
      const services = await createAgentSessionServices({ cwd: directory, agentDir: directory, modelRuntime: runtime, settingsManager: SettingsManager.inMemory(),
        resourceLoaderOptions: { noExtensions: true, noSkills: !resources, noPromptTemplates: !resources, noThemes: true, extensionFactories: [extension] } });
      const ui = { ...toEnumerableExtensionUIContext(new WebExtensionUIBridge({ theme: {} as ExtensionUIContext["theme"] })) };
      ui.input = async () => { calls.questions.push(bridge.questionContext()?.requestId ?? "missing"); return "fixture-answer"; };
      const bridge = createDurableExtensionHost({ services, harness: () => harness, conversation: () => conversation, registry,
        ui, sessionId, systemPrompt: "BASE_PROMPT", onError: error => errors.push(error), isTrusted: () => true });
      await bridge.initialize();
      await conversation.configure({ extensions: [bridge.extension] }, context);
      return bridge;
    }
    const bridge = await host(root, "root-session");
    const close = async () => { await harness.close(context); opened.delete(harness); };
    return { harness, root, bridge, host, close };
  }
  return { open, faux, calls, errors };
}

describe("real Pi ExtensionRunner hosted by Durable without an AgentSession loop", () => {
  it("loads dynamic tools before admission, transforms context/tool results and persists stable capture entries", async () => {
    const f = fixture(); const r = await f.open();
    f.faux.setResponses([
      transcript => {
        expect(transcript.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("RECALL:"))).toBe(true);
        expect(JSON.stringify(transcript.messages)).toContain("MEMORY_PROFILE_FIXTURE");
        return fauxAssistantMessage(fauxToolCall("memory_fixture", { value: "hello" }), { stopReason: "toolUse" });
      },
      transcript => {
        expect(transcript.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "toolResult", isError: false, content: [{ type: "text", text: "checked:hello" }, { type: "text", text: "RESULT_HOOK" }] })]));
        return fauxAssistantMessage("Memory fixture completed");
      },
    ]);
    await r.bridge.beforePrompt("Use memory");
    const submission = await r.root.submit({ type: "input", content: "Use memory", requestId: "extension-first" }, context);
    expect((await submission.wait(context)).status).toBe("done");
    await r.bridge.afterCommit();
    expect(f.calls.toolSessions).toEqual(["root-session"]);
    expect(f.calls.capture).toHaveLength(2);
    const ids = f.calls.capture[0];
    await Promise.all([r.bridge.afterCommit(), r.bridge.afterCommit()]);
    expect(f.calls.capture).toHaveLength(2);
    expect(f.calls.capture[0]).toEqual(ids);
    expect(await r.bridge.handleCommand("/memory_status")).toBe(true);
    const entries = (await r.root.entries({}, 100, undefined, context)).items;
    expect(entries.filter(entry => entry.kind === "pi-web.extension-entry")).toHaveLength(3);
    expect(f.errors).toEqual([]);
    await r.bridge.shutdown();
    expect(f.calls.shutdown).toBe(1);
  });

  it("restores the persisted generation context after close/reopen without recalling again", async () => {
    const f = fixture(); const first = await f.open();
    const requests: string[] = [];
    f.faux.setResponses([async (transcript, options) => {
      requests.push(JSON.stringify(transcript.messages));
      await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return fauxAssistantMessage("", { stopReason: "aborted" });
    }]);
    await first.bridge.beforePrompt("Recover memory");
    await first.root.submit({ type: "input", content: "Recover memory", requestId: "extension-recover" }, context);
    await vi.waitFor(() => expect(f.faux.state.callCount).toBe(1));
    expect(f.calls.contexts).toBe(1);
    await first.close();
    const reopened = await f.open();
    f.faux.setResponses([transcript => { requests.push(JSON.stringify(transcript.messages)); return fauxAssistantMessage("Recovered with the same memory"); }]);
    const recovered = await reopened.root.submit({ type: "input", content: "Recover memory", requestId: "extension-recover" }, context);
    expect((await recovered.wait(context)).status).toBe("done");
    expect(f.calls.contexts).toBe(1);
    expect(requests[1]).toBe(requests[0]);
    expect(f.calls.sessions).toEqual(["root-session", "root-session"]);
  });

  it("rejects root-owned tools in a fork until the fork gets its own isolated extension host", async () => {
    const f = fixture(); const r = await f.open();
    await r.bridge.beforePrompt("Seed");
    f.faux.setResponses([fauxAssistantMessage("Seed response")]);
    await (await r.root.submit({ type: "input", content: "Seed" }, context)).wait(context);
    const forkAt = (await r.root.entries({}, 1, undefined, context)).items[0].id;
    const fork = await r.root.fork(forkAt, { ownership: { kind: "ownerless" } }, context);
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("memory_fixture", { value: "foreign" }), { stopReason: "toolUse" }),
      transcript => {
        expect(transcript.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "toolResult", isError: true })]));
        return fauxAssistantMessage("Isolation held");
      },
    ]);
    await (await fork.submit({ type: "input", content: "Foreign context" }, context)).wait(context);
    expect(f.calls.toolSessions).toEqual([]);
    const forkHost = await r.host(fork, "fork-session");
    await forkHost.beforePrompt("Fork memory");
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("memory_fixture", { value: "own" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Fork complete"),
    ]);
    await (await fork.submit({ type: "input", content: "Fork memory" }, context)).wait(context);
    expect(f.calls.toolSessions).toEqual(["fork-session"]);
    expect(f.calls.sessions).toEqual(["root-session", "fork-session"]);
    expect(f.errors).toEqual([]);
  });
  it("deduplicates prepared requests across concurrent resends and reopening, with stable dialog IDs", async () => {
    const f = fixture(); const first = await f.open();
    await Promise.all([first.bridge.beforePrompt("Question prompt", undefined, "same-prompt"), first.bridge.beforePrompt("Question prompt", undefined, "same-prompt")]);
    expect(f.calls.before).toEqual(["root-session"]);
    expect(f.calls.input).toBe(1);
    expect(f.calls.questions).toEqual(["extension-question:1:same-prompt:before_agent_start:0", "extension-question:1:same-prompt:before_agent_start:1"]);
    await first.close();
    const reopened = await f.open();
    expect(await reopened.bridge.beforePrompt("Question prompt", undefined, "same-prompt")).toEqual({ handled: false, text: "Question prompt" });
    expect(f.calls.before).toHaveLength(1);
    expect(f.calls.input).toBe(1);
    expect(f.calls.questions).toHaveLength(2);
    await expect(reopened.bridge.beforePrompt("Different", undefined, "same-prompt")).rejects.toThrow("conflicts");
  });

  it("runs input interception, official template expansion and skill content expansion before admission", async () => {
    const f = fixture(true); const r = await f.open();
    expect(await r.bridge.beforePrompt("Intercept this", undefined, "handled")).toEqual({ handled: true, text: "Intercept this" });
    expect(f.calls.before).toHaveLength(0);
    expect(await r.bridge.beforePrompt("Rewrite this", undefined, "rewrite")).toMatchObject({ handled: false, text: "Template two words / default" });
    const skill = await r.bridge.beforePrompt("/skill:fixture verify", undefined, "skill");
    expect(skill.text).toContain('<skill name="fixture"');
    expect(skill.text).toContain("Skill body\n</skill>\n\nverify");
    expect(skill.text).not.toContain("description: Fixture skill");
    expect(f.errors).toEqual([]);
  });

  it("makes before-agent-start custom messages visible to the model and to the SDK projection", async () => {
    const f = fixture(); const r = await f.open();
    await r.bridge.beforePrompt("Attach note", undefined, "note");
    f.faux.setResponses([transcript => {
      expect(JSON.stringify(transcript.messages)).toContain("MODEL_VISIBLE_NOTE");
      return fauxAssistantMessage("Saw note");
    }]);
    await (await r.root.submit({ type: "input", content: "Attach note", requestId: "note" }, context)).wait(context);
    await r.bridge.refreshProjection();
    expect(r.bridge.runner.createContext().sessionManager.getBranch()).toEqual(expect.arrayContaining([expect.objectContaining({ type: "custom_message", customType: "fixture-note", content: "MODEL_VISIBLE_NOTE" })]));
    const messages = (await r.root.entries({}, 100, undefined, context)).items.flatMap(entry => entry.model ?? []);
    expect(messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "Saw note" }], stopReason: "stop" })]));
    expect(f.errors).toEqual([]);
  });

});
