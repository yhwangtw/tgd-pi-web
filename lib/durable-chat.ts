import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  AgentDoc, InboxDoc, LiveDoc, GenerationTask, ToolTask, CompactionTask, Harness, createRegistry, defineDoc, defineExtension, defineTool, hook, watchEvents, wrapTool,
  type AgentEvent, type AgentEventStream, type Conversation, type ConversationId, type EntryId, type EntryRecord,
  type HarnessOptions, type Registry, type Storage, type ToolRegistration, type TaskId, type CompactionResult,
} from "@earendil-works/pi-durable";
import { createReadTool, createBashTool, createEditTool, createWriteTool, createGrepTool, createFindTool, createLsTool,
  createAgentSessionServices, type AgentSessionServices, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai-durable";
import { AgentEventLog, type AgentStreamRecord } from "./agent-event-log";
import { createPiModelRuntime } from "./pi-model-runtime";
import { durableModels } from "./durable-models";
import { createDurableMcpExtension } from "./durable-mcp";
import { createDurableQuestionsExtension, durableQuestionSnapshot, respondDurableQuestion, cancelDurableQuestions, waitForDurableHostQuestion, type DurableQuestionDraft } from "./durable-questions";
import { DurableWorkflowDoc, createDurableWorkflowExtension, handleDurableWorkflowCommand, readDurableWorkflow, durableWorkflowUIEvents, pauseDurableWorkflow, flushDurableWorkflowCommand } from "./durable-workflow";
import { createDurableSubagentExtension, DurableSubagentDoc } from "./durable-subagents";
import { DurableSessionMeta, durableContext, durableEntries, durableMessage, durableSessionData, durableSessionDirectory, durableSessionId,
  durableSessionIdentity, saveDurableProjection, writeDurableJson, type DurableSessionProjection } from "./durable-session-store";
import { namesForToolSelection, inferToolSelectionMode, type ToolSelectionMode } from "./tool-selection";
import type { WebExtensionUIEvent, WebExtensionUIResponse } from "./web-extension-ui-types";
import type { CompactionState } from "./compaction-state";
import { WebExtensionUIBridge, toEnumerableExtensionUIContext } from "./web-extension-ui";
import { initializeWebTheme } from "./pi-runtime";
import { createDurableExtensionHost } from "./durable-extension-host";
import { buildExtensionsReport, collectExtensionResources } from "./extensions-info";
import { buildContextReport } from "./context-report";
import { PI_THINKING_LEVELS } from "./thinking-levels";
import type { QueuedFollowUp } from "./queued-follow-ups";
import { buildAgentRunReport } from "./agent-run-report";
import type { AgentRun } from "./agent-run-types";
import { LEGACY_CONTEXT, legacyArchive, legacyContext, legacyModel, legacySettings, legacyWorkflow, plain, type LegacyArchive } from "./durable-legacy";
import { resolveMigratedSessionId } from "./session-migrations";

const context = BACKGROUND_CONTEXT;
const READ_ONLY = new Set(["read", "grep", "find", "ls"]);
const WebCompactions = defineDoc({ kind: "pi-web.compaction-receipts", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ latest: "", requests: {} as Record<string, { taskId: number; instructions: string; startedAt: number }> }) });
const WebShell = defineDoc({ kind: "pi-web.shell-receipts", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ requests: {} as Record<string, { command: string; status: string; output: string; error: string }> }) });
type Command = { type: string; [key: string]: unknown };
export interface DurableChatOptions {
  cwd: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  toolNames?: string[];
  toolMode?: ToolSelectionMode;
  ephemeral?: boolean;
  /** Test injection: no credentials, extensions, project settings or network. */
  models?: HarnessOptions["models"];
  registry?: Registry;
  directory?: string;
  group?: string;
  settings?: HarnessOptions["settings"];
  scheduleDeadline?: number;
  /** Only for a new, unscheduled migration store. */
  legacy?: { archive: LegacyArchive; sourceId: string; name?: string; parentSessionId?: string; instructions?: string };
}
interface Host {
  group: string;
  directory: string;
  cwd: string;
  ephemeral: boolean;
  harness: Harness;
  storage: Storage;
  registry: Registry;
  services?: AgentSessionServices;
  models: HarnessOptions["models"];
  chats: Map<number, DurableChat>;
  release: () => Promise<void>;
  closed: boolean;
  policy: { compactionEnabled: boolean; retryEnabled: boolean };
  baseExtensions: ReturnType<Registry["snapshot"]> extends { installed(): infer T } ? T : never;
  refreshExecutionGuards(): void;
  activateMigration(): void;
  migrationPending(): boolean;
}
declare global {
  var __piDurableHosts: Map<string, Host> | undefined;
  var __piDurableOpenings: Map<string, Promise<Host>> | undefined;
}
const hosts = () => globalThis.__piDurableHosts ??= new Map();
const openings = () => globalThis.__piDurableOpenings ??= new Map();

async function importLegacy(tx: Parameters<Parameters<Conversation["commit"]>[0]>[0], id: ConversationId, archive: LegacyArchive) {
  const saved = legacyWorkflow(archive);
  const workflow = await tx.doc(DurableWorkflowDoc, id);
  workflow.goal = saved.goal; workflow.plan = saved.plan;
  await tx.appendEntry(id, { kind: LEGACY_CONTEXT, data: plain(archive) as never, model: legacyModel(archive), head: "self" });
}

function nativeCodingTools(cwd: string): ToolRegistration[] {
  return [createReadTool, createBashTool, createEditTool, createWriteTool, createGrepTool, createFindTool, createLsTool]
    .map(create => create(cwd)).map(tool => defineTool({
      name: tool.name, description: tool.description, parameters: tool.parameters,
      ...(READ_ONLY.has(tool.name) ? { replay: "safe" as const } : {}),
      async execute(args, api, ctx) {
        // Use the child's configured cwd; never capture its parent's cwd for file work.
        const agent = await api.agent(ctx);
        const factory = [createReadTool, createBashTool, createEditTool, createWriteTool, createGrepTool, createFindTool, createLsTool]
          .find(create => create(cwd).name === tool.name)!;
        const actual = factory(agent.cwd ?? cwd);
        let prior = "";
        const result = await actual.execute(api.callId, args as never, ctx.abortSignal, update => {
          const text = update.content.filter(block => block.type === "text").map(block => block.text).join("\n");
          if (text.startsWith(prior)) api.output(text.slice(prior.length));
          else api.output(text);
          prior = text;
        });
        return { content: result.content, ...(result.details !== undefined ? { details: JSON.parse(JSON.stringify(result.details)) } : {}) };
      },
    }));
}

async function openHost(options: DurableChatOptions): Promise<Host> {
  const group = options.group ?? randomUUID();
  const directory = options.directory ?? durableSessionDirectory(group);
  if (!options.ephemeral) mkdirSync(directory, { recursive: true, mode: 0o700 });
  let harness: Harness | undefined;
  const release = options.ephemeral ? async () => {} : await lockfile.lock(directory, {
    realpath: true, stale: 10_000, update: 5_000,
    retries: { retries: 3, minTimeout: 5_000, maxTimeout: 5_000, factor: 1 },
    onCompromised: () => { void harness?.close(context).catch(() => {}); },
  });
  let storage: Storage | undefined;
  let migrationPending = options.legacy !== undefined;
  try {
    let services: AgentSessionServices | undefined;
    let models = options.models;
    let provider = options.provider;
    let modelId = options.modelId;
    let thinkingLevel = options.thinkingLevel;
    let instructions = "Complete the user's request accurately. Use the available tools and report verified results.";
    if (!models) {
      const runtime = await createPiModelRuntime();
      services = await createAgentSessionServices({ cwd: options.cwd, modelRuntime: runtime });
      models = durableModels(runtime);
      const settings = services.settingsManager;
      provider ??= settings.getDefaultProvider();
      modelId ??= settings.getDefaultModel();
      if (!provider || !modelId) { const model = (await runtime.getAvailable())[0]; provider = model?.provider; modelId = model?.id; }
      thinkingLevel ??= settings.getDefaultThinkingLevel();
      const loader = services.resourceLoader;
      instructions = [loader.getSystemPrompt() ?? instructions, ...loader.getAppendSystemPrompt(),
        ...loader.getAgentsFiles().agentsFiles.map(file => `${file.path}\n${file.content}`), `Working directory: ${options.cwd}`].join("\n\n");
    }
    if (!provider || !modelId) throw new Error("No configured model is available");
    if (options.legacy && !models.getModel(provider, modelId)) throw new Error("The original model is unavailable; choose a configured model before converting");
    instructions = options.legacy?.instructions ?? instructions;
    const registry = createRegistry();
    for (const extension of options.registry?.snapshot().installed() ?? []) registry.install(extension);
    registry.install(defineExtension({ name: "pi-web-coding", tools: nativeCodingTools(options.cwd) }));
    const workflowBlocks = new Map<number, string>();
    const requestBlocks = new WeakMap<object, string>();
    const emit = (event: WebExtensionUIEvent, conversationId?: number) => {
      // Dialog IDs include the conversation; snapshots remain authoritative on reconnect.
      for (const chat of host?.chats.values() ?? []) if (conversationId === undefined || chat.conversation.id === conversationId) void chat.refreshUI(event).catch(() => {});
    };
    registry.install(createDurableQuestionsExtension({ emit }));
    registry.install(createDurableWorkflowExtension({ harness: () => harness!, beforeRequest: ({ taskId, blockReason }) => {
      if (blockReason) workflowBlocks.set(taskId, blockReason); else workflowBlocks.delete(taskId);
    } }));
    const subagents = createDurableSubagentExtension({ getHarness: () => harness!, isProjectTrusted: () => services?.settingsManager.isProjectTrusted() ?? true,
      sessionId: id => durableSessionId(group, id),
      onChild: async child => { await host.chats.get(child.conversationId)?.refresh(); },
      beforeChild: async id => { const conversation = await harness!.conversation(id as ConversationId, context); if (conversation) await DurableChat.attach(host, conversation); } });
    registry.install(subagents);
    if (!options.models) registry.install(await createDurableMcpExtension(options.cwd));
    // Hooks are advisory upstream. Associate each immutable request message with
    // the decision, then enforce it synchronously at the actual provider boundary.
    const admission = defineExtension({ name: "pi-web-admission", hooks: [
      hook(GenerationTask, { beforeRequest: (request, api) => {
        const reason = workflowBlocks.get(api.taskId);
        if (reason) for (const message of request.messages) requestBlocks.set(message, reason);
        return undefined;
      } }),
      hook(ToolTask, { beforeTool: () => {
        if (options.scheduleDeadline && Date.now() >= options.scheduleDeadline) return { block: "Scheduled run reached its time limit" };
        if (services && !services.settingsManager.isProjectTrusted()) return { block: "Workspace is not trusted" };
      } }),
    ] });
    const refreshExecutionGuards = () => {
      const unique = new Map(registry.snapshot().tools().map(({ tool }) => [tool.name, tool]));
      registry.install({ ...admission, wraps: [...unique.values()].map(tool => wrapTool(tool, original => ({ ...original,
        execute: async (args, api, ctx) => {
          if (migrationPending) throw new Error("Execution is disabled until session conversion is verified");
          if (options.scheduleDeadline && Date.now() >= options.scheduleDeadline) throw new Error("Scheduled run reached its time limit");
          if (services && !services.settingsManager.isProjectTrusted()) throw new Error("Workspace is not trusted");
          await subagents.checkExecution(api, ctx);
          return original.execute(args, api, ctx);
        },
      }))) });
    };
    refreshExecutionGuards();
    const guardedModels = new Proxy(models, { get(target, key) {
      const value = Reflect.get(target, key);
      if (key === "streamSimple") return (...args: unknown[]) => {
        if (migrationPending) throw new Error("Model execution is disabled until session conversion is verified");
        if (options.scheduleDeadline && Date.now() >= options.scheduleDeadline) throw new Error("Scheduled run reached its time limit");
        if (services && !services.settingsManager.isProjectTrusted()) throw new Error("Workspace is not trusted");
        const transcript = args[1] as { messages?: object[] };
        for (const message of transcript.messages ?? []) { const reason = requestBlocks.get(message); if (reason) throw new Error(reason); }
        return Reflect.apply(value, target, args);
      };
      return typeof value === "function" ? value.bind(target) : value;
    } });
    storage = options.ephemeral ? new MemoryStorage() : await openNodeSqliteStorage(join(directory, "session.sqlite"));
    if (!options.ephemeral) chmodSync(join(directory, "session.sqlite"), 0o600);
    const policy = { compactionEnabled: options.settings?.compaction?.enabled ?? services?.settingsManager.getCompactionEnabled() ?? true,
      retryEnabled: options.settings?.retry?.enabled ?? services?.settingsManager.getRetryEnabled() ?? true };
    const baseExtensions = registry.snapshot().installed();
    harness = await Harness.open(storage, { models: guardedModels, registry,
      settings: { ...options.settings, extensions: baseExtensions, get compaction() { return { ...options.settings?.compaction, enabled: policy.compactionEnabled }; },
        get retry() { return { ...options.settings?.retry, enabled: policy.retryEnabled }; } },
    }, context);
    const host: Host = { group, directory, cwd: options.cwd, ephemeral: options.ephemeral === true, harness, storage, registry,
      models, services, chats: new Map(), release, closed: false, policy, baseExtensions, refreshExecutionGuards,
      activateMigration: () => { migrationPending = false; }, migrationPending: () => migrationPending };
    const initialNames = namesForToolSelection(options.toolMode ?? inferToolSelectionMode(options.toolNames), options.toolNames);
    const initialTools = registry.snapshot().tools().map(({ tool }) => tool);
    const root = await harness.root(context, { agent: { cwd: options.cwd, model: { provider, modelId }, thinkingLevel: (thinkingLevel ?? "off") as ModelThinkingLevel, instructions,
      ...(initialNames ? { tools: initialTools.filter(tool => initialNames.includes(tool.name)) } : {}) },
      init: async (tx, id) => { (await tx.doc(DurableSessionMeta, id)).created = new Date().toISOString();
        // Preserve explicit extension tool names until its per-conversation
        // registrations load. An empty selection remains empty throughout startup.
        if (initialNames) (await tx.doc(AgentDoc, id)).tools = [...initialNames];
        if (options.legacy) {
          const meta = await tx.doc(DurableSessionMeta, id);
          meta.created = options.legacy.archive.header.timestamp;
          meta.sourceSessionId = options.legacy.sourceId;
          meta.name = options.legacy.name ?? "";
          meta.parentSessionId = options.legacy.parentSessionId ?? "";
          await importLegacy(tx, id, options.legacy.archive);
        }
      } });
    const rootMeta = await harness.snapshot(DurableSessionMeta, root.id, context);
    if (!options.legacy && rootMeta?.sourceSessionId && resolveMigratedSessionId(rootMeta.sourceSessionId) !== durableSessionId(group, root.id)) throw new Error("Session conversion was not published; continue from the original conversation");
    if (!options.ephemeral) writeDurableJson(join(directory, "bootstrap.json"), { version: 1, cwd: options.cwd, scheduleDeadline: options.scheduleDeadline });
    hosts().set(group, host);
    if (!(await harness.snapshot(DurableSessionMeta, root.id, context))?.deleted) await DurableChat.attach(host, root);
    // Reinstall code for every persisted conversation before the scheduler can
    // resume an owned child. Reading/opening alone still runs no model tasks.
    let cursor: Parameters<Storage["scanConversations"]>[2];
    do { const page = await storage.scanConversations({}, 100, cursor, context); cursor = page.next;
      for (const item of page.items) if (item.id !== root.id && !(await harness.snapshot(DurableSessionMeta, item.id, context))?.deleted) {
        const conversation = await harness.conversation(item.id, context); if (conversation) await DurableChat.attach(host, conversation);
      }
    } while (cursor !== undefined);
    return host;
  } catch (error) {
    const failedHost = hosts().get(group);
    await Promise.allSettled([...(failedHost?.chats.values() ?? [])].map(chat => chat.getExtensionHost()?.shutdown()));
    hosts().delete(group);
    if (harness) await harness.close(context).catch(() => {});
    else await storage?.close(context).catch(() => {});
    await release();
    throw error;
  }
}

export async function createDurableChat(options: DurableChatOptions): Promise<DurableChat> {
  const host = await openHost(options);
  const root = host.chats.get(1);
  if (!root) throw new Error("Root conversation was deleted; open a surviving branch by its session ID");
  return root;
}
export function getDurableChat(id: string): DurableChat | undefined {
  const identity = durableSessionIdentity(id);
  const chat = identity ? hosts().get(identity.group)?.chats.get(identity.conversation) : undefined;
  const source = chat?.getProjection()?.info.sourceSessionId;
  return source && resolveMigratedSessionId(source) !== id ? undefined : chat;
}
/** Reopen without scheduling. SSE reconnect or an explicit command resumes work. */
export async function openDurableChat(id: string, options?: DurableChatOptions): Promise<DurableChat> {
  const identity = durableSessionIdentity(id);
  if (!identity) throw new Error("Invalid Durable session ID");
  let host = hosts().get(identity.group);
  if (!host || host.closed) {
    let pending = openings().get(identity.group);
    if (!pending) {
      const config = JSON.parse(readFileSync(join(options?.directory ?? durableSessionDirectory(identity.group), "bootstrap.json"), "utf8")) as { cwd: string; scheduleDeadline?: number };
      pending = openHost({ ...options, cwd: config.cwd, group: identity.group, scheduleDeadline: config.scheduleDeadline });
      openings().set(identity.group, pending);
    }
    try { host = await pending; } finally { openings().delete(identity.group); }
  }
  const existing = host.chats.get(identity.conversation);
  if (existing) {
    const source = existing.getProjection().info.sourceSessionId;
    if (source && resolveMigratedSessionId(source) !== id) throw new Error("Session conversion is not yet published");
    return existing;
  }
  const conversation = await host.harness.conversation(identity.conversation as ConversationId, context);
  if (!conversation) throw new Error("Session not found");
  return DurableChat.attach(host, conversation);
}

export class DurableChat {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly cwd: string;
  private watcher!: AgentEventStream;
  private eventLog = new AgentEventLog();
  private listeners = new Set<(record: AgentStreamRecord) => void>();
  private eventListeners = new Set<(event: Record<string, unknown>) => void>();
  private ui: WebExtensionUIEvent[] = [];
  private live: Awaited<ReturnType<typeof this.readLive>>;
  private projection!: DurableSessionProjection;
  private lastError: string | null = null;
  private compaction: CompactionState | null = null;
  private bashAbort?: AbortController;
  private bashRun: { command: string; output: string; running: boolean } | null = null;
  private extensionHost?: ReturnType<typeof createDurableExtensionHost>;
  private services?: AgentSessionServices;
  private extensionUI = new WebExtensionUIBridge({ emit: event => this.emit(event as unknown as Record<string, unknown>), acceptDialogs: false });
  private extensionErrors: Array<{ type: "error"; message: string; path?: string }> = [];
  private hostAbort = new AbortController();
  private projectionUpdates: Promise<void> = Promise.resolve();
  private queuedFollowUps: QueuedFollowUp[] = [];
  private constructor(private host: Host, readonly conversation: Conversation) {
    this.sessionId = durableSessionId(host.group, conversation.id);
    this.sessionFile = host.ephemeral ? "" : join(host.directory, "session.sqlite");
    this.cwd = host.cwd;
  }
  get harness(): Harness { return this.host.harness; }
  activateMigration(): void { this.host.activateMigration(); }
  static async attach(host: Host, conversation: Conversation): Promise<DurableChat> {
    const existing = host.chats.get(conversation.id); if (existing) return existing;
    const meta = await host.harness.snapshot(DurableSessionMeta, conversation.id, context);
    if (meta?.deleted) throw new Error("Session was deleted");
    const owned = await host.harness.snapshot(DurableSubagentDoc, conversation.id, context);
    if (owned?.ownerTaskId && !meta?.created) await conversation.commit(async tx => {
      const metadata = await tx.doc(DurableSessionMeta, conversation.id);
      metadata.created = new Date(owned.startedAt || Date.now()).toISOString(); metadata.parentSessionId = durableSessionId(host.group, owned.parentConversationId);
      metadata.name = `${owned.agent}: ${owned.task.slice(0, 60)}`;
    }, context);
    const chat = new DurableChat(host, conversation);
    host.chats.set(conversation.id, chat);
    chat.watcher = await watchEvents(host.harness, conversation.id, context);
    await chat.refresh();
    await chat.initializeExtensions();
    if (host.migrationPending() && chat.extensionErrors.length) throw new Error(`Extension compatibility check failed: ${chat.extensionErrors[0].message}`);
    await chat.refreshUI();
    chat.watcher.start(async events => {
      if (events.some(event => ["snapshot", "entry_appended", "message_end", "agent_changed", "run_end", "compaction_end"].includes(event.type))) await chat.refresh();
      else chat.live = await chat.readLive();
      for (const event of events) await chat.forward(event);
      if (events.some(event => ["message_end", "run_end", "tool_execution_end", "compaction_end"].includes(event.type))) {
        try { await chat.extensionHost?.afterCommit(); } catch (error) { chat.extensionErrors.push({ type: "error", message: String(error) }); }
      }
      await chat.refreshUI();
    });
    return chat;
  }
  isAlive(): boolean { return !this.host.closed && !this.projection?.deleted; }
  getServices() { return this.services; }
  getExtensionHost() { return this.extensionHost; }
  getRuntimeDiagnostics() { return { state: this.isAlive() ? "ready" as const : "disposed" as const, sessionId: this.sessionId,
    sessionFile: this.sessionFile, cwd: this.cwd, connectedClients: this.listeners.size, replacementCount: 0 }; }
  getExtensionsReport() {
    if (!this.extensionHost) throw new Error("Extensions are unavailable for this isolated runtime");
    const report = buildExtensionsReport(this.extensionHost.runner, { loadResult: this.services?.resourceLoader.getExtensions(),
      resources: this.services ? collectExtensionResources(this.services.resourceLoader) : [], runtimeDiagnostics: this.extensionErrors, runtime: this.getRuntimeDiagnostics() });
    report.commands.unshift(...["goal", "plan"].map(name => ({ name, invocationName: name, source: "Pi Web Durable", description: name === "goal" ? "Manage the saved goal" : "Manage the saved plan" })));
    const names = new Set(report.tools.map(tool => tool.name));
    for (const { tool } of this.host.registry.snapshot().tools()) if (!names.has(tool.name)) { report.tools.push({ name: tool.name, description: tool.description, source: "Pi Web Durable" }); names.add(tool.name); }
    return report;
  }
  async getContextReport() {
    const agent = await this.conversation.agent(context);
    const all = agent.extensions.flatMap(extension => extension.tools ?? []);
    const active = agent.tools.map(tool => tool.name);
    return buildContextReport({ sessionId: this.sessionId, model: this.getState().model, resourceLoader: this.services?.resourceLoader,
      sessionManager: { getCwd: () => this.cwd }, settingsManager: { isProjectTrusted: () => this.services?.settingsManager.isProjectTrusted() ?? true },
      agent: { state: { systemPrompt: this.projection.agent.instructions } }, getActiveToolNames: () => active,
      getAllTools: () => all.map(tool => ({ name: tool.name, description: tool.description })), getContextUsage: () => undefined });
  }
  async summarize(): Promise<{ name: string; skipped?: boolean }> {
    if (this.projection.info.name) return { name: this.projection.info.name, skipped: true };
    const ref = this.projection.agent.model;
    const model = ref ? this.host.models.getModel(ref.provider, ref.modelId) : undefined;
    if (!model) throw new Error("No model configured");
    if (this.services && !this.services.settingsManager.isProjectTrusted()) throw new Error("Workspace is not trusted");
    const extract = (role: string) => {
      const message = this.projection.context.messages.find(message => message.role === role);
      if (!message || !("content" in message)) return "";
      return (typeof message.content === "string" ? message.content : message.content.filter(block => block.type === "text").map(block => block.type === "text" ? block.text : "").join(" ")).slice(0, 500);
    };
    const user = extract("user"), assistant = extract("assistant");
    if (!user || !assistant) throw new Error("No conversation to summarize");
    const result = await this.host.models.completeSimple(model, { messages: [{ role: "user", content: `Generate only a concise title, at most 10 words, in the conversation's language.\nUser: ${user}\nAssistant: ${assistant}`, timestamp: Date.now() }] }, { maxTokens: 30, signal: AbortSignal.timeout(15_000) });
    if (result.stopReason === "error" || result.stopReason === "aborted") throw new Error(result.errorMessage ?? "Title generation failed");
    const name = result.content.filter(block => block.type === "text").map(block => block.type === "text" ? block.text : "").join("").trim().replace(/^["']|["']$/g, "").slice(0, 80);
    if (!name) throw new Error("Empty title");
    // A title manually saved while the model was answering takes precedence.
    const saved = await this.harness.snapshot(DurableSessionMeta, this.conversation.id, context);
    if (saved?.name) return { name: saved.name, skipped: true };
    await this.rename(name); return { name };
  }
  private async question(draft: DurableQuestionDraft, requestId?: string) {
    if (this.host.migrationPending()) throw new Error("An extension requires input during conversion; answer it in Standard mode first");
    const invocation = this.extensionHost?.questionContext();
    return waitForDurableHostQuestion(this.harness, this.conversation, draft, { ...invocation, requestId: requestId ?? invocation?.requestId,
      signal: invocation?.signal ?? this.hostAbort.signal, emit: event => { void this.refreshUI(event).catch(() => {}); } });
  }
  private persistentUI(): ExtensionUIContext {
    const ui = toEnumerableExtensionUIContext(this.extensionUI);
    return { ...ui,
      select: async (title, options, config) => { const result = await this.question({ method: "select", title, options, ...(config?.timeout !== undefined ? { timeout: config.timeout } : {}) }); return result.response && "value" in result.response ? result.response.value : undefined; },
      input: async (title, placeholder, config) => { const result = await this.question({ method: "input", title, placeholder, ...(config?.timeout !== undefined ? { timeout: config.timeout } : {}) }); return result.response && "value" in result.response ? result.response.value : undefined; },
      editor: async (title, prefill) => { const result = await this.question({ method: "editor", title, prefill }); return result.response && "value" in result.response ? result.response.value : undefined; },
      confirm: async (title, message, config) => { const result = await this.question({ method: "confirm", title, message, ...(config?.timeout !== undefined ? { timeout: config.timeout } : {}) }); return !!(result.response && "confirmed" in result.response && result.response.confirmed); },
    };
  }
  private async initializeExtensions(): Promise<void> {
    if (!this.host.services) return;
    this.services = this.conversation.id === 1 ? this.host.services : await createAgentSessionServices({ cwd: this.cwd, modelRuntime: this.host.services.modelRuntime });
    initializeWebTheme(this.services.settingsManager);
    this.extensionHost = createDurableExtensionHost({ services: this.services, harness: () => this.harness, conversation: () => this.conversation,
      registry: this.host.registry, ui: theme => { this.extensionUI.setPiTheme(theme); return this.persistentUI(); }, sessionId: this.sessionId, systemPrompt: this.projection.agent.instructions ?? "",
      onError: error => this.extensionErrors.push({ type: "error", message: `${error.event}: ${error.error}`, path: error.extensionPath }),
      actions: { setSessionName: name => { void this.rename(name); } },
      commandActions: { reload: () => this.reloadExtensions(), fork: async id => { const child = await this.fork(id, true); this.emit({ type: "session_replaced", previousSessionId: this.sessionId, newSessionId: child.sessionId, cwd: child.cwd, sessionFile: child.sessionFile }); return { cancelled: false }; } },
    });
    const base = this.host.baseExtensions;
    const admission = base.find(extension => extension.name === "pi-web-admission")!;
    await this.conversation.configure({ extensions: [...base.filter(extension => extension !== admission), this.extensionHost.extension, admission] }, context);
    await this.extensionHost.initialize();
    this.host.refreshExecutionGuards();
    await this.refresh();
  }
  async reloadExtensions(): Promise<void> {
    if (this.live?.run || this.live?.compactions?.length) throw new Error("Wait for the current response before reloading extensions");
    await this.extensionHost?.shutdown();
    await this.services?.resourceLoader.reload();
    await this.initializeExtensions();
    this.emit(this.streamSnapshot());
  }
  async resume(): Promise<void> { await flushDurableWorkflowCommand(this.conversation, this.harness); this.harness.resume(); }
  private emit(event: Record<string, unknown>): void {
    const isUI = typeof event.type === "string" && event.type.startsWith("extension_ui_");
    const record = isUI ? { data: JSON.stringify(event) } : this.eventLog.append(event);
    if (isUI && event.method === "set_editor_text" && (this.listeners.size || this.eventListeners.size)) this.extensionUI.acknowledgeDelivery(String(event.id));
    for (const listener of this.listeners) listener(record);
    for (const listener of this.eventListeners) listener(event);
  }
  onEvent(listener: (event: Record<string, unknown>) => void): () => void {
    this.eventListeners.add(listener);
    for (const event of this.ui) listener(event as unknown as Record<string, unknown>);
    this.clearDeliveredEditor();
    return () => { this.eventListeners.delete(listener); };
  }
  onStreamEvent(listener: (record: AgentStreamRecord) => void, cursor: string | null): () => void {
    const replay = this.eventLog.replay(cursor);
    this.listeners.add(listener);
    // The complete committed snapshot also reconciles queues and dialogs after lost events.
    for (const record of replay.records) listener(record);
    listener({ id: this.eventLog.cursor, data: JSON.stringify(this.streamSnapshot(replay.status)) });
    for (const event of this.ui) listener({ data: JSON.stringify(event) });
    this.clearDeliveredEditor();
    return () => { this.listeners.delete(listener); };
  }
  private clearDeliveredEditor(): void {
    this.ui = this.ui.filter(item => !(item.type === "extension_ui_request" && item.method === "set_editor_text"));
  }
  private readLive() { return this.harness.snapshot(LiveDoc, this.conversation.id, context); }
  refresh(): Promise<void> {
    const next = this.projectionUpdates.then(() => this.refreshProjection());
    this.projectionUpdates = next.catch(() => {});
    return next;
  }
  private readonly projectedContinuations = new Set<string>();
  private async refreshProjection(): Promise<void> {
    // History is immutable and append-only. Read only newly committed entries
    // after attachment; partial token commits never rescan the entire history.
    const previous = this.projection?.entries ?? [];
    const additions: EntryRecord[] = [];
    const newest = previous.at(-1)?.id;
    let cursor: Parameters<Conversation["entries"]>[2];
    do { const page = await this.conversation.entries(newest === undefined ? {} : { minEntryId: newest }, 250, cursor, context); additions.push(...page.items.filter(entry => newest === undefined || entry.id > newest)); cursor = page.next; } while (cursor !== undefined);
    const entries = [...previous, ...additions.reverse()];
    // Upstream appends automatic continuation inputs as ordinary user entries.
    // Match the saved generation receipt and immediate successor before hiding
    // them, so user-written text with the same content remains a user message.
    const workflow = await this.harness.snapshot(DurableWorkflowDoc, this.conversation.id, context);
    for (const [id, continuation] of Object.entries(workflow?.continuations ?? {})) {
      if (!continuation.text || this.projectedContinuations.has(id)) continue;
      const task = await this.harness.getTask(Number(id) as TaskId<{ entryId?: number }>, context);
      if (task?.state.status !== "terminal" || task.state.outcome.status !== "completed") continue;
      const answerEntryId = task.state.outcome.result?.entryId;
      const index = entries.findIndex(entry => entry.id === answerEntryId);
      const next = index >= 0 ? entries[index + 1] : undefined;
      if (next?.kind !== "pi.user" || next.model?.length !== 1 || next.model[0].content !== continuation.text) continue;
      entries[index + 1] = { ...next, kind: "pi-web.extension-message", data: { customType: "pi-web-goal-continuation", content: continuation.text, display: false, details: null } };
      this.projectedContinuations.add(id);
    }
    const agent = await this.harness.snapshot(AgentDoc, this.conversation.id, context) ?? {};
    const meta = await this.harness.snapshot(DurableSessionMeta, this.conversation.id, context);
    this.live = await this.readLive();
    this.queuedFollowUps = await this.readQueue();
    this.compaction = await this.readCompactionState();
    const created = meta?.created || new Date(0).toISOString();
    const messages = durableEntries(entries, created).flatMap(entry => entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant") ? [{ message: entry.message, entryId: entry.id }] : []);
    const extract = (message: { content?: unknown } | undefined) => typeof message?.content === "string" ? message.content : Array.isArray(message?.content)
      ? message.content.filter(block => block.type === "text").map(block => block.text).join("\n") : "";
    const last = messages.at(-1);
    const modified = last && "timestamp" in last.message ? new Date(last.message.timestamp ?? Date.parse(created)).toISOString() : created;
    this.projection = { version: 1, deleted: meta?.deleted ?? false, entries, agent, context: durableContext(entries, agent),
      info: { id: this.sessionId, path: this.sessionFile, cwd: this.cwd, created, modified, name: meta?.name || undefined,
        sourceSessionId: meta?.sourceSessionId || undefined,
        parentSessionId: meta?.parentSessionId ? resolveMigratedSessionId(meta.parentSessionId) : undefined, messageCount: messages.length,
        firstMessage: extract(messages.find(({ message }) => message.role === "user")?.message) || "(no messages)",
        lastMessage: extract(last?.message), lastMessageId: last?.entryId, ephemeral: this.host.ephemeral, engine: "durable" } };
    const owned = await this.harness.snapshot(DurableSubagentDoc, this.conversation.id, context);
    if (owned?.ownerTaskId) this.projection.agentRun = {
      id: this.sessionId, engine: "durable", durableConversation: true, sessionId: this.sessionId, trigger: "subagent",
      name: this.projection.info.name ?? owned.agent, cwd: owned.cwd, prompt: owned.task, toolNames: [...owned.tools], limits: owned.limits,
      parentRunId: durableSessionId(this.host.group, owned.parentConversationId), status: owned.status as AgentRun["status"], createdAt: created,
      ...(owned.startedAt ? { startedAt: new Date(owned.startedAt).toISOString() } : {}), ...(owned.finishedAt ? { finishedAt: new Date(owned.finishedAt).toISOString() } : {}),
      error: owned.error || undefined, progress: { turns: owned.turns, costUsd: owned.modelCost },
      report: buildAgentRunReport(this.projection.context.messages, owned.startedAt ? new Date(owned.startedAt).toISOString() : undefined),
    };
    if (!this.host.ephemeral) saveDurableProjection(this.host.directory, this.conversation.id, this.projection);
  }
  async refreshUI(event?: WebExtensionUIEvent): Promise<void> {
    if (!this.isAlive()) return;
    const questions = await durableQuestionSnapshot(this.harness, this.conversation);
    const workflow = durableWorkflowUIEvents(await readDurableWorkflow(this.harness, this.conversation.id));
    const signature = (events: WebExtensionUIEvent[]) => JSON.stringify(events.map(item => ({ ...item, id: item.type === "extension_ui_request" && ["setWidget", "setStatus"].includes(item.method) ? "" : item.id })));
    const extensionState = this.extensionUI.snapshot();
    const pendingEditor = this.ui.filter(item => item.type === "extension_ui_request" && item.method === "set_editor_text");
    const next = [...questions, ...workflow, ...extensionState,
      ...(!extensionState.some(item => item.type === "extension_ui_request" && item.method === "set_editor_text") && !this.listeners.size && !this.eventListeners.size ? pendingEditor : [])];
    if (this.projection.agentRun && ["running", "waiting_for_input"].includes(this.projection.agentRun.status)) {
      const status = questions.length ? "waiting_for_input" : "running";
      if (this.projection.agentRun.status !== status) {
        this.projection.agentRun.status = status;
        if (!this.host.ephemeral) saveDurableProjection(this.host.directory, this.conversation.id, this.projection);
      }
    }
    if (signature(next) !== signature(this.ui)) { this.ui = next; for (const item of next) this.emit(item as unknown as Record<string, unknown>); }
    if (this.listeners.size || this.eventListeners.size) this.clearDeliveredEditor();
    if (event?.type === "extension_ui_closed") this.emit(event as unknown as Record<string, unknown>);
  }
  private async forward(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "snapshot": this.emit(this.streamSnapshot("reset")); break;
      case "run_start": this.lastError = null; this.emit({ type: "agent_start" }); break;
      case "run_end": this.emit({ type: "agent_end", messages: this.projection.context.messages, goalActive: (await readDurableWorkflow(this.harness, this.conversation.id)).goal?.status === "active" }); break;
      case "message_start": { const message = durableMessage(event.message); if (message) this.emit({ type: "message_start", message }); break; }
      case "message_update": { const message = this.live?.generation?.message; if (message) this.emit({ type: "message_update", message: durableMessage(message) }); break; }
      case "message_end": for (const message of durableContext([this.projection.entries.find(entry => entry.id === event.entry.id) ?? event.entry], {}).messages) this.emit({ type: "message_end", message }); break;
      case "tool_execution_end": this.emit({ type: event.type, toolCallId: event.toolCallId, toolName: event.toolName, result: event.entry?.model?.[0], isError: event.entry?.model?.some(message => message.role === "toolResult" && message.isError) }); break;
      case "task_failed": this.lastError = event.message; this.emit({ type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: event.message }] }); break;
      case "compaction_start": this.compaction = await this.readCompactionState(); if (this.compaction) this.emit({ type: "compaction_status", compaction: this.compaction }); else this.emit({ type: "auto_compaction_start", reason: event.reason }); break;
      case "compaction_end": this.compaction = await this.readCompactionState(); if (this.compaction) this.emit({ type: "compaction_status", compaction: this.compaction }); else this.emit({ type: "auto_compaction_end", aborted: false }); this.emit(this.streamSnapshot()); break;
      case "inbox_update": this.queuedFollowUps = await this.readQueue(); this.emit({ type: "queue_update", items: this.queuedFollowUps }); break;
      case "agent_changed": this.emit(this.streamSnapshot()); break;
      default: if (["tool_execution_start", "tool_execution_update", "turn_start", "turn_end", "auto_retry_start", "auto_retry_end"].includes(event.type)) this.emit({ ...event });
    }
  }
  getSessionData() { return durableSessionData(this.projection); }
  getProjection(): DurableSessionProjection { return this.projection; }
  getState() {
    const model = this.projection.agent.model;
    return { sessionId: this.sessionId, sessionFile: this.sessionFile, engine: "durable", isStreaming: !!this.live?.run,
      isCompacting: !!this.live?.compactions?.length, compaction: this.compaction, autoCompactionEnabled: this.host.policy.compactionEnabled, autoRetryEnabled: this.host.policy.retryEnabled,
      model: model ? { id: model.modelId, provider: model.provider } : undefined, thinkingLevel: this.projection.agent.thinkingLevel ?? "off",
      messageCount: this.projection.context.messages.length, pendingMessageCount: this.queuedFollowUps.length, queuedFollowUps: this.queuedFollowUps, contextUsage: null, systemPrompt: this.projection.agent.instructions ?? "" };
  }
  private async readQueue(): Promise<QueuedFollowUp[]> {
    const inbox = await this.harness.snapshot(InboxDoc, this.conversation.id, context);
    return (inbox?.items ?? []).flatMap(item => {
      if (item.mode !== "followUp") return [];
      const content = item.content;
      const message = typeof content === "string" ? content : content.filter(block => block.type === "text").map(block => block.type === "text" ? block.text : "").join("\n");
      const images = typeof content === "string" ? [] : content.flatMap(block => block.type === "image" ? [{ data: block.data, mimeType: block.mimeType }] : []);
      return [{ id: String(item.id), message, ...(images.length ? { images } : {}) }];
    });
  }
  private streamSnapshot(replayStatus = "initial") {
    const tools = Object.values(this.live?.tools ?? {});
    return { type: "session_snapshot", protocolVersion: 1, sessionId: this.sessionId, cursor: this.eventLog.cursor, replayStatus,
      state: this.getState(), sessionData: this.getSessionData(), streamingMessage: this.live?.generation?.message ? durableMessage(this.live.generation.message) : null,
      phase: tools.length ? { kind: "running_tools", tools: tools.map(tool => ({ id: tool.callId, name: tool.name })) } : null,
      bashRun: this.bashRun, lastRunError: this.lastError };
  }
  private async readCompactionState(): Promise<CompactionState | null> {
    const doc = await this.harness.snapshot(WebCompactions, this.conversation.id, context);
    const receipt = doc?.requests[doc.latest];
    if (!doc || !receipt) return null;
    const task = await this.harness.getTask(receipt.taskId as TaskId<CompactionResult>, context);
    const base = { id: doc.latest, reason: "manual", startedAt: receipt.startedAt };
    if (!task || task.state.status !== "terminal") return { ...base, status: "running" };
    const outcome = task.state.outcome;
    if (outcome.status === "completed") {
      const written = outcome.result.entryId !== undefined || outcome.result.submissionId !== undefined;
      return written ? { ...base, status: "completed" } : { ...base, status: "skipped", notice: "nothing_to_compact" };
    }
    return outcome.status === "aborted" ? { ...base, status: "cancelled" }
      : { ...base, status: "failed", error: "error" in outcome ? outcome.error?.message ?? "Compaction interrupted" : "Compaction interrupted" };
  }
  private async compact(command: Command): Promise<CompactionState> {
    const id = typeof command.requestId === "string" ? command.requestId : randomUUID();
    const instructions = typeof command.customInstructions === "string" ? command.customInstructions : "";
    const task = await this.conversation.commit(async tx => {
      const receipts = await tx.doc(WebCompactions, this.conversation.id);
      const existing = receipts.requests[id];
      if (existing) { if (existing.instructions !== instructions) throw new Error("Compaction receipt conflicts with this request"); return existing.taskId as TaskId<CompactionResult>; }
      const live = await tx.doc(LiveDoc, this.conversation.id);
      if (live.compactions?.length) return live.compactions[0].taskId;
      const taskId = await tx.createTask(CompactionTask, { reason: "manual" as const, ...(instructions ? { instructions } : {}) }, { conversationId: this.conversation.id, ownership: { kind: "conversation" } });
      live.compactions ??= []; live.compactions.push({ taskId, reason: "manual", blocking: false, attempt: 1 });
      receipts.latest = id; receipts.requests[id] = { taskId, instructions, startedAt: Date.now() };
      return taskId;
    }, context);
    this.harness.resume();
    if (command.background !== true) await this.harness.waitForTask(task, context);
    await this.refresh();
    return this.compaction ?? { id, reason: "manual", status: "running", startedAt: Date.now() };
  }
  private async shell(command: Command): Promise<unknown> {
    if (this.bashAbort) throw new Error("A shell command is already running");
    if (this.host.services && !this.host.services.settingsManager.isProjectTrusted()) throw new Error("Workspace is not trusted");
    const text = typeof command.command === "string" ? command.command : "";
    if (!text.trim()) throw new Error("Shell command is required");
    const id = typeof command.requestId === "string" ? command.requestId : randomUUID();
    const previous = await this.conversation.commit(async tx => {
      const doc = await tx.doc(WebShell, this.conversation.id);
      const saved = doc.requests[id];
      if (saved) { if (saved.command !== text) throw new Error("Shell receipt conflicts with this command"); return { ...saved }; }
      doc.requests[id] = { command: text, status: "running", output: "", error: "" }; return null;
    }, context);
    if (previous) {
      if (previous.status === "running") throw new Error("Shell command was interrupted; inspect its effects before submitting a new command");
      if (previous.error) throw new Error(previous.error);
      return { output: previous.output };
    }
    this.bashAbort = new AbortController(); this.bashRun = { command: text, output: "", running: true };
    this.emit({ type: "bash_start", command: text });
    let output = "";
    try {
      const result = await createBashTool(this.cwd).execute(id, { command: text }, this.bashAbort.signal, update => {
        const text = update.content.filter(block => block.type === "text").map(block => block.text).join("\n");
        const chunk = text.startsWith(output) ? text.slice(output.length) : text; output = text;
        this.bashRun!.output = output; this.emit({ type: "bash_chunk", chunk });
      });
      output = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
      await this.conversation.submit({ type: "write", requestId: `shell:${id}`, entry: { kind: "pi-web.shell", data: { command: text, output, timestamp: Date.now(), excludeFromContext: command.excludeFromContext === true },
        ...(command.excludeFromContext === true ? {} : { model: [{ role: "user", content: `Shell command: ${text}\n${output}`, timestamp: Date.now() }] }) } }, context);
      await this.conversation.commit(async tx => { const receipt = (await tx.doc(WebShell, this.conversation.id)).requests[id]; receipt.output = output; receipt.status = "completed"; }, context);
      this.emit({ type: "bash_end", exitCode: 0, cancelled: false }); await this.refresh(); return { output, exitCode: 0, cancelled: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.conversation.commit(async tx => { const receipt = (await tx.doc(WebShell, this.conversation.id)).requests[id]; receipt.status = "failed"; receipt.error = message; }, context);
      this.emit({ type: "bash_end", errorMessage: message }); throw error;
    } finally { this.bashAbort = undefined; this.bashRun = null; }
  }
  async rename(name: string): Promise<void> { await this.conversation.commit(async tx => { (await tx.doc(DurableSessionMeta, this.conversation.id)).name = name.trim(); }, context); await this.refresh(); }
  async remove(): Promise<void> {
    await this.send({ type: "abort" });
    await this.conversation.commit(async tx => { (await tx.doc(DurableSessionMeta, this.conversation.id)).deleted = true; }, context);
    const parent = this.projection.info.parentSessionId ?? "";
    let cursor: Parameters<Storage["scanConversations"]>[2];
    do {
      const page = await this.host.storage.scanConversations({}, 250, cursor, context); cursor = page.next;
      for (const child of page.items) {
        const meta = await this.harness.snapshot(DurableSessionMeta, child.id, context);
        if (meta?.parentSessionId !== this.sessionId) continue;
        await this.harness.commit(async tx => { (await tx.doc(DurableSessionMeta, child.id)).parentSessionId = parent; }, context);
        const childChat = this.host.chats.get(child.id) ?? await DurableChat.attach(this.host, (await this.harness.conversation(child.id, context))!);
        await childChat.refresh();
      }
    } while (cursor !== undefined);
    await this.refresh();
    this.emit({ type: "session_closed" });
    await this.watcher.stop();
  }
  async fork(entryId?: string, before = false): Promise<DurableChat> {
    if (this.live?.run) throw new Error("Wait for the current response before branching");
    const archive = legacyArchive(this.projection.entries);
    const legacyEntry = archive?.entries.find(entry => entry.id === entryId);
    if (archive && legacyEntry) {
      const branch = { ...archive, leafId: before ? legacyEntry.parentId : legacyEntry.id };
      const selected = legacyContext(branch);
      const settings = legacySettings(branch);
      const child = await this.harness.createConversation({ ownership: { kind: "ownerless" },
        agent: { model: selected.model ?? this.projection.agent.model, cwd: this.cwd, instructions: settings.instructions ?? this.projection.agent.instructions,
          tools: settings.toolNames ? this.host.registry.snapshot().tools().map(({ tool }) => tool).filter(tool => settings.toolNames!.includes(tool.name)) : (await this.conversation.agent(context)).tools,
          thinkingLevel: selected.thinkingLevel as ModelThinkingLevel },
        init: async (tx, id) => {
          const meta = await tx.doc(DurableSessionMeta, id); meta.created = new Date().toISOString(); meta.parentSessionId = this.sessionId;
          await importLegacy(tx, id, branch);
        },
      }, context);
      return DurableChat.attach(this.host, child);
    }
    const visible = this.projection.entries;
    const chosen = entryId === undefined ? visible.at(-1) : visible.find(entry => String(entry.id) === entryId.replace(/^durable:/, "").split(":")[0]);
    if (entryId !== undefined && !chosen) throw new Error("Invalid branch entry");
    const at = before && chosen ? visible[visible.indexOf(chosen) - 1]?.id : chosen?.id;
    const options = { ownership: { kind: "ownerless" as const }, init: async (tx: Parameters<Parameters<Conversation["commit"]>[0]>[0], id: ConversationId) => {
      const meta = await tx.doc(DurableSessionMeta, id); meta.created = new Date().toISOString(); meta.parentSessionId = this.sessionId;
    } };
    const child = at ? await this.conversation.fork(at as EntryId, options, context) : await this.harness.createConversation({ ...options,
      agent: { model: this.projection.agent.model, cwd: this.cwd, instructions: this.projection.agent.instructions,
        tools: (await this.conversation.agent(context)).tools, thinkingLevel: this.projection.agent.thinkingLevel } }, context);
    await pauseDurableWorkflow(child, "Paused after branching. Resume when ready.");
    return DurableChat.attach(this.host, child);
  }
  async send(command: Command): Promise<unknown> {
    if (!this.isAlive()) throw new Error("Session is closed");
    switch (command.type) {
      case "get_state": await this.refresh(); return this.getState();
      case "prompt": case "steer": case "follow_up": case "queue_compaction_prompt": {
        const message = typeof command.message === "string" ? command.message : "";
        if (command.type === "prompt" && await handleDurableWorkflowCommand(this.conversation, this.harness, message, context, this.host.services ? { ui: this.persistentUI() } : {})) { await this.refresh(); await this.refreshUI(); this.emit(this.streamSnapshot()); return null; }
        if (command.type === "prompt" && await this.extensionHost?.handleCommand(message)) return null;
        const images = Array.isArray(command.images) ? command.images as Array<{ type: "image"; data: string; mimeType: string }> : [];
        const requestId = typeof command.requestId === "string" ? command.requestId : typeof command.id === "string" ? command.id : randomUUID();
        const prepared = await this.extensionHost?.beforePrompt(message, images, requestId);
        if (prepared?.handled) { await this.refresh(); this.emit(this.streamSnapshot()); return null; }
        this.host.refreshExecutionGuards();
        const text = prepared?.text ?? message, attachments = prepared?.images ?? images;
        const content = attachments.length ? [...(text ? [{ type: "text" as const, text }] : []), ...attachments] : text;
        const submission = await this.conversation.submit({ type: "input", content, requestId,
          whenBusy: command.type === "steer" || command.mode === "steer" ? "steer" : "followUp" }, context);
        if (command.awaitCompletion === true) { const result = await submission.wait(context); if (result.status !== "done") throw new Error(`Response did not complete: ${result.reason}`); await this.refresh(); }
        return { submissionId: submission.id };
      }
      case "workflow_command": {
        if (!["goal", "plan"].includes(String(command.command))) throw new Error("Unknown workflow command");
        await handleDurableWorkflowCommand(this.conversation, this.harness, `/${command.command} ${command.args ?? ""}`, context, this.host.services ? { ui: this.persistentUI() } : {});
        await this.refresh(); await this.refreshUI(); this.emit(this.streamSnapshot()); return null;
      }
      case "abort": await pauseDurableWorkflow(this.conversation); await this.conversation.abort(context, { background: true }); await cancelDurableQuestions(this.harness, this.conversation); await this.refresh(); return null;
      case "extension_ui_response": return respondDurableQuestion(this.harness, this.conversation, command as unknown as WebExtensionUIResponse, { emit: event => { this.emit(event as unknown as Record<string, unknown>); } });
      case "set_model": {
        const provider = String(command.provider); const modelId = String(command.modelId);
        if (!this.host.models.getModel(provider, modelId)) throw new Error("Model not found");
        await this.conversation.configure({ model: { provider, modelId } }, context); await this.refresh(); return { id: modelId, provider };
      }
      case "set_thinking_level": {
        const level = String(command.level);
        if (!(PI_THINKING_LEVELS as readonly string[]).includes(level)) throw new Error("Invalid thinking level");
        await this.conversation.configure({ thinkingLevel: level as ModelThinkingLevel }, context); await this.refresh(); return null;
      }
      case "get_tools": {
        const agent = await this.conversation.agent(context); const active = new Set(agent.tools.map(tool => tool.name));
        return { mode: inferToolSelectionMode([...active]), selectedNames: [...active], tools: agent.extensions.flatMap(extension => extension.tools ?? []).map(tool => ({ name: tool.name, description: tool.description, active: active.has(tool.name), source: tool.name.startsWith("mcp_") ? "mcp" : "extension" })) };
      }
      case "set_tools": {
        const mode = (command.mode ?? inferToolSelectionMode(command.toolNames as string[] | undefined)) as ToolSelectionMode;
        const names = namesForToolSelection(mode, command.toolNames as string[] | undefined);
        const tools = (await this.conversation.agent(context)).extensions.flatMap(extension => extension.tools ?? []);
        if (names?.some(name => !tools.some(tool => tool.name === name))) throw new Error("Unknown tool in selection");
        await this.conversation.configure({ tools: names ? tools.filter(tool => names.includes(tool.name)) : null }, context); await this.refresh(); return { mode, selectedNames: names ?? [] };
      }
      case "set_project_trust": this.host.services?.settingsManager.setProjectTrusted(command.trusted === true); return { trusted: command.trusted === true };
      case "compact": return this.compact(command);
      case "bash": return this.shell(command);
      case "abort_bash": this.bashAbort?.abort(); return null;
      case "set_auto_compaction": this.host.policy.compactionEnabled = command.enabled === true; this.host.services?.settingsManager.setCompactionEnabled(command.enabled === true); return null;
      case "set_auto_retry": this.host.policy.retryEnabled = command.enabled === true; this.host.services?.settingsManager.setRetryEnabled(command.enabled === true); return null;
      case "recover_runtime": await this.resume(); return { sessionId: this.sessionId, cwd: this.cwd, sessionFile: this.sessionFile };
      case "retry_compaction_queue": await this.resume(); return null;
      case "abort_compaction": for (const item of this.live?.compactions ?? []) await this.harness.abortTask(item.taskId, context); return null;
      case "fork": case "navigate_tree": { const fork = await this.fork(String(command.entryId ?? command.targetId), command.type === "fork"); return { cancelled: false, newSessionId: fork.sessionId }; }
      case "reset": await this.conversation.reset(command.handoff as string | undefined, context); await this.refresh(); return null;
      case "replace_queue": {
        const items = command.items as QueuedFollowUp[];
        if (!Array.isArray(items) || items.some(item => typeof item.id !== "string" || typeof item.message !== "string") || new Set(items.map(item => item.id)).size !== items.length) throw new Error("Invalid queue edit");
        await this.conversation.commit(async tx => {
          const inbox = await tx.doc(InboxDoc, this.conversation.id);
          const existing = inbox.items.filter(item => item.mode === "followUp");
          if (items.some(item => !existing.some(saved => String(saved.id) === item.id))) throw new Error("A queued message was already delivered; reload before editing");
          for (const item of existing) if (!items.some(next => next.id === String(item.id))) tx.settleSubmission(item.id, { status: "unanswered", reason: "aborted" });
          inbox.items = [...inbox.items.filter(item => item.mode !== "followUp"), ...items.map(item => {
            const saved = existing.find(saved => String(saved.id) === item.id)!;
            return { ...saved, content: item.images?.length ? [{ type: "text" as const, text: item.message }, ...item.images.map(image => ({ ...image, type: "image" as const }))] : item.message };
          })];
        }, context);
        this.queuedFollowUps = await this.readQueue(); this.emit({ type: "queue_update", items: this.queuedFollowUps }); return this.queuedFollowUps;
      }
      case "clear_compaction_queue": case "clear_queue": { const inbox = await this.harness.snapshot(InboxDoc, this.conversation.id, context); for (const item of inbox?.items ?? []) await this.harness.abortSubmission(item.id, context, this.conversation.id); return null; }
      default: throw new Error(`Unsupported Durable command: ${command.type}`);
    }
  }
  /** Stops this host without cancelling durable tasks; a later open can resume. */
  async close(): Promise<void> {
    if (this.host.closed) return;
    for (const chat of this.host.chats.values()) chat.hostAbort.abort();
    this.host.closed = true;
    for (const chat of this.host.chats.values()) { await chat.watcher.stop(); chat.emit({ type: "session_restart" }); }
    await this.harness.close(context);
    await this.host.release();
    hosts().delete(this.host.group);
  }
}
