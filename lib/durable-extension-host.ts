import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context, JsonValue } from "@earendil-works/chord";
import {
  ExtensionRunner, ModelRegistry, SessionManager, stripFrontmatter, getPackageDir,
  type AgentSessionServices, type ExtensionActions, type ExtensionCommandContextActions,
  type ExtensionError, type ExtensionUIContext, type FileEntry, type SessionEntry, type SessionBeforeCompactEvent, type ToolCallEvent, type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent, Message } from "@earendil-works/pi-ai";
import {
  AgentDoc, CompactionTask, defineDoc, defineEntry, defineExtension, defineTool,
  GenerationTask, hook, InboxDoc, LiveDoc, section, ToolTask,
  type Conversation, type EntryRecord, type Harness, type HookApi, type JsonObject,
  type Registry, type ToolExecutionApi, type ToolRegistration,
} from "@earendil-works/pi-durable";

import { LEGACY_CONTEXT, legacyArchive, legacyBoundary, type LegacyArchive } from "./durable-legacy";

export interface DurablePreparedPrompt { handled: boolean; text: string; images?: ImageContent[] }
type PreparedPromptReceipt = { systemPrompt: string; input: JsonValue; fingerprint?: string };
const CustomMessageEntry = defineEntry<{ customType: string; content: JsonValue; display: boolean; details: JsonValue }>("pi-web.extension-message");
const CustomEntry = defineEntry<{ customType: string; data: JsonValue }>("pi-web.extension-entry");
const ExtensionDoc = defineDoc({
  kind: "pi-web.extension-host", version: 1, scope: "conversation", history: "rewindable", fork: "asOf",
  initial: () => ({ systemPrompt: "", appended: {} as Record<string, boolean>, deliveredTurns: {} as Record<string, boolean>, preparedPrompts: {} as Record<string, PreparedPromptReceipt>, endedAt: "" }),
});
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const LEGACY_BUILTINS = new Set(["<inline:Plan Mode>", "<inline:pi-web-workflow>", "<inline:Structured Output>", "<inline:pi-web-mcp>", "<inline:pi-web-subagent>"]);
const READ_METHODS = new Set(["getCwd", "getSessionDir", "getSessionId", "getSessionFile", "getLeafId", "getLeafEntry", "getEntry", "getLabel", "getBranch", "buildContextEntries", "getHeader", "getEntries", "getTree", "getSessionName"]);

export interface DurableExtensionHostOptions {
  /** Must be freshly created for this conversation: extension factories share their runtime bindings. */
  services: AgentSessionServices;
  harness: () => Harness;
  conversation: () => Conversation;
  registry: Registry;
  ui: ExtensionUIContext | ((theme: ExtensionUIContext["theme"]) => ExtensionUIContext);
  sessionId: string;
  systemPrompt: string;
  isTrusted?: () => boolean;
  onError?: (error: ExtensionError) => void;
  actions?: Partial<ExtensionActions>;
  commandActions?: Partial<ExtensionCommandContextActions>;
}

/** Durable entries projected through the real SDK SessionManager, with stable entry IDs. */
export function durableExtensionEntries(entries: readonly EntryRecord[], cwd: string, sessionId: string): FileEntry[] {
  const output: FileEntry[] = [{ type: "session", version: 3, id: sessionId, cwd, timestamp: "1970-01-01T00:00:00.000Z" }];
  let parentId: string | null = null;
  const prefix = legacyArchive(entries) ? "durable:" : "";
  for (const entry of entries) {
    if (entry.kind === LEGACY_CONTEXT) {
      const archive = entry.data as unknown as LegacyArchive;
      const boundary = legacyBoundary(entry, archive);
      output.push(...plain(archive.entries), boundary); parentId = boundary.id; continue;
    }
    const base: { id: string; parentId: string | null; timestamp: string } = { id: `${prefix}${entry.id}`, parentId, timestamp: new Date(entry.model?.[0]?.timestamp ?? 0).toISOString() };
    if (entry.kind === CustomMessageEntry.kind) {
      const data = entry.data as { customType: string; content: string; display: boolean; details: unknown };
      output.push({ ...base, type: "custom_message", ...data });
      parentId = base.id;
      continue;
    }
    if (entry.kind === CustomEntry.kind) {
      const data = entry.data as { customType: string; data?: unknown };
      output.push({ ...base, type: "custom", customType: data.customType, data: data.data });
      parentId = base.id;
      continue;
    }
    if (entry.kind === "pi.compaction") {
      const summary = entry.model?.flatMap(message => typeof message.content === "string" ? [message.content] : message.content.filter(block => block.type === "text").map(block => block.text)).join("\n") ?? "";
      output.push({ ...base, type: "compaction", summary, firstKeptEntryId: `${prefix}${entry.head ?? entry.id}`, tokensBefore: 0 });
      parentId = base.id;
      continue;
    }
    for (const [index, message] of (entry.model ?? []).entries()) {
      const id = index === 0 ? base.id : `${base.id}:${index}`;
      output.push({ ...base, id, parentId, type: "message", message: plain(message) as unknown as Extract<SessionEntry, { type: "message" }>["message"] });
      parentId = id;
    }
  }
  return output;
}

/** A single-conversation compatibility layer. It never creates an AgentSession or a second agent loop. */
export function createDurableExtensionHost(options: DurableExtensionHostOptions) {
  const context = BACKGROUND_CONTEXT;
  const conversationId = options.conversation().id;
  const name = `pi-web-legacy:${conversationId}`;
  const cwd = options.services.cwd;
  const bundle = options.services.resourceLoader.getExtensions();
  const extensions = bundle.extensions.filter(extension => !LEGACY_BUILTINS.has(extension.path));
  const local = new AsyncLocalStorage<{ api?: HookApi | ToolExecutionApi; signal?: AbortSignal; event: string; key: string; appendIndex: number; dialogIndex: number }>();
  let projection = SessionManager.inMemory(cwd, { id: options.sessionId });
  const projectionProxy = new Proxy(projection, {
    get(_target, key) {
      if (typeof key === "string" && !READ_METHODS.has(key)) throw new Error(`SessionManager.${key} is read-only in Durable extensions; use pi.appendEntry or the host session API.`);
      const value = Reflect.get(projection, key, projection);
      return typeof value === "function" ? value.bind(projection) : value;
    },
  });
  const runner = new ExtensionRunner(extensions, bundle.runtime, cwd, projectionProxy, new ModelRegistry(options.services.modelRuntime));
  if (options.onError) runner.onError(options.onError);
  runner.setUIContext(typeof options.ui === "function" ? options.ui(runner.getUIContext().theme) : options.ui, "rpc");
  let initialized = false;
  let closed = false;
  let pending = Promise.resolve();
  let commitEvents = Promise.resolve();
  let promptEvents = Promise.resolve();
  let activeTools: string[] = [];
  let currentModel: ReturnType<typeof options.services.modelRuntime.getModel>;
  let thinking = "off";
  let idle = true;
  let hasPending = false;
  let systemPrompt = options.systemPrompt;

  function enqueue(work: () => Promise<unknown>) {
    pending = pending.then(work).then(() => undefined);
    void pending.catch(() => {});
  }
  async function flush() { await pending; }
  async function refreshProjection() {
    const entries: EntryRecord[] = [];
    let cursor: Parameters<Conversation["entries"]>[2];
    do {
      const page = await options.conversation().entries({}, 200, cursor, context);
      entries.push(...page.items); cursor = page.next;
    } while (cursor !== undefined);
    projection = SessionManager.inMemory(cwd, { id: options.sessionId }, durableExtensionEntries(entries.reverse(), cwd, options.sessionId));
    const agent = await options.conversation().agent(context);
    activeTools = agent.tools.map(tool => tool.name);
    thinking = agent.thinkingLevel;
    currentModel = agent.model ? options.services.modelRuntime.getModel(agent.model.provider, agent.model.modelId) : undefined;
    idle = !(await options.harness().snapshot(LiveDoc, conversationId, context))?.run;
    hasPending = Boolean((await options.harness().snapshot(InboxDoc, conversationId, context))?.items.some(item => item.mode !== "write"));
  }
  const invoke = <T>(event: string, api: HookApi | ToolExecutionApi | undefined, callContext: Context, work: () => Promise<T>, stableKey?: string) => local.run({ api, signal: callContext.abortSignal, event, key: stableKey ?? (api ? String(api.taskId) : randomUUID()), appendIndex: 0, dialogIndex: 0 }, work);
  function effectId() {
    const invocation = local.getStore();
    return invocation ? `${invocation.key}:${invocation.event}:${invocation.appendIndex++}` : randomUUID();
  }
  function questionContext() {
    const invocation = local.getStore();
    return invocation ? { requestId: `extension-question:${conversationId}:${invocation.key}:${invocation.event}:${invocation.dialogIndex++}`, signal: invocation.signal } : undefined;
  }
  function append(customType: string, data: unknown) {
    const key = effectId();
    const serialized = data === undefined ? null : plain(data) as JsonValue;
    enqueue(() => options.conversation().commit(async tx => {
      const state = await tx.doc(ExtensionDoc, conversationId);
      if (state.appended[key]) return;
      await tx.appendEntry(CustomEntry, conversationId, { data: { customType, data: serialized } });
      state.appended[key] = true;
    }, context));
  }
  const unsupported = (action: string) => () => { throw new Error(`Extension action ${action} requires a Durable host adapter.`); };
  const refreshTools = () => { options.registry.install(extension()); };
  runner.bindCore({
    sendMessage: (message, delivery) => {
      if (delivery?.triggerTurn) {
        append(message.customType, { content: message.content, details: message.details, display: message.display });
        const requestId = effectId();
        enqueue(() => options.conversation().submit({ type: "input", content: message.content as never, whenBusy: delivery.deliverAs === "steer" ? "steer" : undefined, requestId }, context));
      } else {
        const requestId = effectId();
        const content = plain(message.content ?? []);
        // Passive writes go through the native inbox, preserving tool-call/result
        // ordering even when an extension emits a message from inside a tool.
        enqueue(() => options.conversation().submit({ type: "write", requestId, entry: {
          kind: CustomMessageEntry.kind,
          data: { customType: message.customType, content: content as JsonValue, display: message.display, details: message.details === undefined ? null : plain(message.details) as JsonValue },
          model: [{ role: "user", content: content as never, timestamp: Date.now() }],
        } }, context));
      }
    },
    sendUserMessage: (content, delivery) => { const requestId = effectId(); enqueue(() => options.conversation().submit({ type: "input", content: content as never, whenBusy: delivery?.deliverAs === "steer" ? "steer" : undefined, requestId }, context)); },
    appendEntry: append,
    setSessionName: unsupported("setSessionName"), getSessionName: () => projection.getSessionName(), setLabel: unsupported("setLabel"),
    getActiveTools: () => [...activeTools], getAllTools: () => runner.getAllRegisteredTools().map(tool => ({ ...tool.definition, sourceInfo: tool.sourceInfo })),
    setActiveTools: names => { activeTools = [...names]; enqueue(() => options.conversation().commit(async tx => { (await tx.doc(AgentDoc, conversationId)).tools = [...names]; }, context)); },
    refreshTools, getCommands: () => runner.getRegisteredCommands().map(command => ({ name: command.name, description: command.description, source: "extension" as const, sourceInfo: command.sourceInfo })),
    setModel: async model => { await options.conversation().configure({ model: { provider: model.provider, modelId: model.id } }, context); currentModel = model; return true; },
    getThinkingLevel: () => thinking as ReturnType<ExtensionActions["getThinkingLevel"]>,
    setThinkingLevel: level => { thinking = level; enqueue(() => options.conversation().configure({ thinkingLevel: level }, context)); },
    ...options.actions,
  }, {
    getModel: () => currentModel, getScopedModels: () => [], isIdle: () => idle, isProjectTrusted: options.isTrusted ?? (() => options.services.settingsManager.isProjectTrusted()),
    getSignal: () => local.getStore()?.signal, abort: () => { void options.conversation().abort(context); }, hasPendingMessages: () => hasPending,
    shutdown: () => { void options.conversation().abort(context); }, getContextUsage: () => undefined,
    compact: compactOptions => { void options.conversation().compact(compactOptions?.customInstructions, context).catch(error => compactOptions?.onError?.(error)); },
    getSystemPrompt: () => systemPrompt, getSystemPromptOptions: () => ({ cwd, forceSystemPrompt: systemPrompt }),
  });
  runner.bindCommandContext({
    waitForIdle: () => options.conversation().waitForIdle(context),
    newSession: async () => { throw new Error("Extension newSession requires a Durable host adapter."); },
    fork: async () => { throw new Error("Extension fork requires a Durable host adapter."); },
    navigateTree: async () => { throw new Error("Extension navigateTree requires a Durable host adapter."); },
    switchSession: async () => { throw new Error("Extension switchSession requires a Durable host adapter."); },
    reload: async () => { throw new Error("Extension reload requires a Durable host adapter."); },
    ...options.commandActions,
  });

  function extension() {
    const tools: ToolRegistration[] = runner.getAllRegisteredTools().map(({ definition }) => defineTool({
      name: definition.name, description: definition.description, parameters: definition.parameters,
      executionMode: definition.executionMode, prepareArguments: definition.prepareArguments,
      async execute(args, api, callContext) {
        if (api.conversationId !== conversationId) throw new Error("Extension tool belongs to another conversation. Initialize its own extension host first.");
        await refreshProjection();
        return invoke(`tool:${api.callId}`, api, callContext, async () => {
          let previous = "";
          const result = await definition.execute(api.callId, args as never, callContext.abortSignal, update => {
            const text = update.content.filter(block => block.type === "text").map(block => block.text).join("\n");
            api.output(text.startsWith(previous) ? text.slice(previous.length) : text); previous = text;
            if (update.details !== undefined) void api.details(plain(update.details) as JsonValue, callContext);
          }, runner.createContext());
          await flush();
          return { ...plain(result), ...(result.terminate ? { control: { terminate: true as const } } : {}) } as never;
        });
      },
    }));
    return defineExtension({ name, tools,
      sections: [section("pi_web_external_extensions", async (input, callContext) => {
        if (input.conversationId !== conversationId) return undefined;
        const saved = await input.read.snapshot(ExtensionDoc, conversationId, callContext);
        // The base is already a host section; contribute only the extension suffix when possible.
        const text = saved?.systemPrompt || systemPrompt;
        return text.startsWith(options.systemPrompt) ? text.slice(options.systemPrompt.length).trim() || undefined : text;
      }, { tag: false })],
      hooks: [hook(GenerationTask, {
        beforeRequest: async (request, api, callContext) => {
          if (api.conversationId !== conversationId) return undefined;
          await refreshProjection();
          const memo = await api.memo<{ messages: JsonValue }>("pi-web.extensions.context", callContext);
          if (memo) return { messages: memo.messages as unknown as typeof request.messages };
          const messages = await invoke("context", api, callContext, () => runner.emitContext(plain(request.messages) as never));
          await flush();
          const saved = await api.memo("pi-web.extensions.context", { messages: plain(messages) as unknown as JsonValue }, callContext);
          return { messages: saved.messages as unknown as typeof request.messages };
        },
      }), hook(ToolTask, {
        beforeTool: async (call, api, callContext) => {
          if (api.conversationId !== conversationId) return;
          await refreshProjection();
          const event = { type: "tool_call", toolCallId: call.id, toolName: call.name, input: plain(call.arguments) } as ToolCallEvent;
          const decision = await invoke("tool_call", api, callContext, () => runner.emitToolCall(event));
          await flush();
          return decision?.block ? { block: decision.reason ?? "Extension blocked tool execution" } : { arguments: plain(event.input) as JsonObject };
        },
        afterTool: async (call, result, api, callContext) => {
          if (api.conversationId !== conversationId) return undefined;
          const patched = await invoke("tool_result", api, callContext, () => runner.emitToolResult({ type: "tool_result", toolCallId: call.id, toolName: call.name, input: plain(call.arguments), content: plain(result.content ?? []), details: result.details, isError: result.isError ?? false, usage: result.usage } as ToolResultEvent));
          await flush();
          return patched ? { ...result, ...plain(patched) } as typeof result : undefined;
        },
      }), hook(CompactionTask, {
        beforeCompact: async (compaction, api, callContext) => {
          if (api.conversationId !== conversationId || !runner.hasHandlers("session_before_compact")) return undefined;
          await refreshProjection();
          const event: SessionBeforeCompactEvent = { type: "session_before_compact", reason: compaction.reason, willRetry: compaction.reason === "overflow", branchEntries: projection.getBranch(), customInstructions: compaction.instructions, signal: callContext.abortSignal ?? new AbortController().signal,
            preparation: { firstKeptEntryId: String(compaction.firstKept), messagesToSummarize: compaction.messages as unknown as Message[], turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 0, fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() }, settings: options.services.settingsManager.getCompactionSettings() } };
          const result = await invoke("session_before_compact", api, callContext, () => runner.emit(event));
          await flush();
          if (result?.cancel) return { decline: true };
          return result?.compaction ? { summary: result.compaction.summary } : undefined;
        },
      })],
    });
  }

  async function initialize() {
    if (initialized) return;
    initialized = true;
    await refreshProjection();
    systemPrompt = (await options.harness().snapshot(ExtensionDoc, conversationId, context))?.systemPrompt || options.systemPrompt;
    await invoke("session_start", undefined, context, () => runner.emit({ type: "session_start", reason: "startup" }));
    await flush(); refreshTools();
  }
  async function preparePrompt(prompt: string, images: ImageContent[] | undefined, requestId: string) {
    await initialize();
    await refreshProjection();
    const fingerprint = createHash("sha256").update(JSON.stringify({ prompt, images: images ?? [] })).digest("hex");
    const saved = await options.harness().snapshot(ExtensionDoc, conversationId, context);
    if (saved?.preparedPrompts[requestId] !== undefined) {
      const receipt = saved.preparedPrompts[requestId];
      if (receipt.fingerprint && receipt.fingerprint !== fingerprint) throw new Error("Prompt request ID conflicts with its saved input");
      systemPrompt = receipt.systemPrompt;
      return plain(receipt.input) as unknown as DurablePreparedPrompt;
    }
    const inputResult = await invoke("input", undefined, context, () => runner.emitInput(prompt, images, "interactive"), requestId);
    await flush();
    let input: DurablePreparedPrompt = { handled: inputResult.action === "handled", text: inputResult.action === "transform" ? inputResult.text : prompt, images: inputResult.action === "transform" ? inputResult.images ?? images : images };
    if (input.handled) {
      await options.conversation().commit(async tx => { (await tx.doc(ExtensionDoc, conversationId)).preparedPrompts[requestId] = plain({ systemPrompt, input, fingerprint }) as unknown as PreparedPromptReceipt; }, context);
      return input;
    }
    input = { ...input, text: await expandInput(input.text) };
    const result = await invoke("before_agent_start", undefined, context, () => runner.emitBeforeAgentStart(input.text, input.images, { cwd, forceSystemPrompt: options.systemPrompt }), requestId);
    await flush();
    systemPrompt = result.systemPromptOptions.forceSystemPrompt ?? options.systemPrompt;
    // Receipt and returned messages are atomic. External effects performed inside the
    // hook remain at-least-once across a crash and need extension-owned deduplication.
    await options.conversation().commit(async tx => {
      const state = await tx.doc(ExtensionDoc, conversationId);
      if (state.preparedPrompts[requestId] !== undefined) return;
      state.systemPrompt = systemPrompt;
      for (const message of result.messages) {
        await tx.appendEntry(CustomMessageEntry, conversationId, {
          data: { customType: message.customType, content: plain(message.content) as JsonValue, details: message.details === undefined ? null : plain(message.details) as JsonValue, display: message.display },
          model: [{ role: "user", content: message.content as never, timestamp: Date.now() }],
        });
      }
      state.preparedPrompts[requestId] = plain({ systemPrompt, input, fingerprint }) as unknown as PreparedPromptReceipt;
    }, context);
    refreshTools();
    await invoke("agent_start", undefined, context, () => runner.emit({ type: "agent_start" }), requestId);
    await flush();
    return input;
  }
  async function expandInput(text: string): Promise<string> {
    const match = /^\/skill:([^ ]+)(?: ([\s\S]*))?$/.exec(text);
    const skill = match && options.services.resourceLoader.getSkills().skills.find(item => item.name === match[1]);
    if (skill && match) {
      try {
        const body = stripFrontmatter(await readFile(skill.filePath, "utf8")).trim();
        const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
        text = match[2]?.trim() ? `${block}\n\n${match[2].trim()}` : block;
      } catch (error) {
        runner.emitError({ extensionPath: skill.filePath, event: "skill_expansion", error: error instanceof Error ? error.message : String(error) });
      }
    }
    const templates = options.services.resourceLoader.getPrompts().prompts;
    if (templates.length) {
      // Pi 0.86 does not export this helper publicly; resolve its pinned official
      // implementation relative to the installed SDK rather than cloning parsing.
      const source = pathToFileURL(join(getPackageDir(), "dist/core/prompt-templates.js"));
      const official = await import(/* webpackIgnore: true */ source.href) as { expandPromptTemplate(text: string, values: typeof templates): string };
      text = official.expandPromptTemplate(text, templates);
    }
    return text;
  }
  function beforePrompt(prompt: string, images?: ImageContent[], requestId: string = randomUUID()) {
    const result = promptEvents.then(() => preparePrompt(prompt, images, requestId));
    promptEvents = result.then(() => undefined, () => {});
    return result;
  }
  async function emitCommittedEvents() {
    if (closed) return;
    await refreshProjection();
    const branch = projection.getBranch();
    const assistants = branch.filter((entry): entry is Extract<SessionEntry, { type: "message" }> => entry.type === "message" && entry.message.role === "assistant");
    const delivered = (await options.harness().snapshot(ExtensionDoc, conversationId, context))?.deliveredTurns ?? {};
    for (const [index, entry] of assistants.entries()) {
      if (delivered[entry.id]) continue;
      const start = branch.indexOf(entry);
      const next = branch.slice(start + 1).findIndex(item => item.type === "message" && (item.message.role === "assistant" || item.message.role === "user"));
      const tail = next < 0 ? branch.slice(start + 1) : branch.slice(start + 1, start + 1 + next);
      const toolResults = tail.flatMap(item => item.type === "message" && item.message.role === "toolResult" ? [item.message] : []);
      const calls = entry.message.role === "assistant" ? entry.message.content.filter(block => block.type === "toolCall") : [];
      if (calls.some(call => !toolResults.some(result => result.toolCallId === call.id))) continue;
      await invoke(`turn_end:${entry.id}`, undefined, context, () => runner.emit({ type: "turn_end", turnIndex: index, message: entry.message, toolResults }), entry.id);
      await flush();
      await options.conversation().commit(async tx => { (await tx.doc(ExtensionDoc, conversationId)).deliveredTurns[entry.id] = true; }, context);
    }
    const lastAssistant = assistants.at(-1)?.id;
    if (idle && lastAssistant && (await options.harness().snapshot(ExtensionDoc, conversationId, context))?.endedAt !== lastAssistant) {
      await invoke("agent_end", undefined, context, () => runner.emit({ type: "agent_end", messages: projection.buildSessionContext().messages }), lastAssistant);
      await flush();
      await options.conversation().commit(async tx => { (await tx.doc(ExtensionDoc, conversationId)).endedAt = lastAssistant; }, context);
    }
  }
  function afterCommit() {
    const result = commitEvents.then(emitCommittedEvents);
    commitEvents = result.catch(() => {});
    return result;
  }
  async function handleCommand(message: string) {
    const match = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(message.trim());
    if (!match) return false;
    const command = runner.getCommand(match[1]);
    if (!command) return false;
    await refreshProjection();
    await command.handler(match[2] ?? "", runner.createCommandContext());
    await flush(); refreshTools();
    return true;
  }
  async function shutdown() {
    if (closed) return;
    await afterCommit();
    await runner.emit({ type: "session_shutdown", reason: "quit" });
    await flush();
    closed = true;
    runner.invalidate("Durable extension host closed");
  }
  return { name, get extension() { return extension(); }, runner, initialize, beforePrompt, afterCommit, handleCommand, shutdown, flush, refreshProjection, questionContext };
}
