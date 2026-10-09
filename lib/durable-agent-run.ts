import { mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry, defineExtension, defineTool, GenerationTask, Harness, hook,
  section, ToolTask, watchEvents,
  type Conversation, type EntryId, type EntryRecord, type HarnessOptions, type ToolRegistration,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  createReadTool, createBashTool, createEditTool, createWriteTool,
  createGrepTool, createFindTool, createLsTool, getAgentDir,
  createAgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai-durable";
import type { AgentRun, AgentRunReport, DurableRunTranscript } from "./agent-run-types";
import type { AgentMessage } from "./types";
import { DURABLE_AGENT_TOOLS } from "./agent-run-types";
import { normalizeToolCalls } from "./normalize";
import { createPiModelRuntime } from "./pi-model-runtime";
import { durableModels } from "./durable-models";
import { readAgentRunStore } from "./agent-run-store";

const context = BACKGROUND_CONTEXT;
const READ_ONLY = new Set(["read", "grep", "find", "ls"]);
const TRANSCRIPT_LIMIT = 200;

export interface DurableRunHandle {
  run(): Promise<{ messages: AgentMessage[]; usage: AgentRunReport["usage"]; error?: string }>;
  abort(): Promise<void>;
  close(): Promise<void>;
}

export interface DurableRunOptions {
  directory?: string;
  models?: HarnessOptions["models"];
  registry?: HarnessOptions["registry"];
  instructions?: string;
  /** Read the latest explicit limits, cancellation and trust before each call. */
  currentRun?: () => AgentRun;
  trusted?: () => Promise<boolean>;
  onProgress?: (progress: { turns: number; costUsd: number }) => void;
}

export function durableRunDirectory(id: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) {
    throw new Error("Invalid Durable run ID");
  }
  return join(getAgentDir(), "durable-runs", id);
}

export function readDurableTranscript(id: string): DurableRunTranscript {
  try {
    return JSON.parse(readFileSync(join(durableRunDirectory(id), "transcript.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { messages: [], truncated: false, updatedAt: new Date().toISOString() };
    }
    throw error;
  }
}

function messagesFrom(entries: readonly EntryRecord[]): AgentMessage[] {
  return entries.flatMap(entry => entry.model ?? [])
    .filter(message => message.role !== "system")
    .map(message => {
      const content = Array.isArray(message.content) ? message.content.map(block => block.type === "image"
        ? { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } }
        : block) : message.content;
      return normalizeToolCalls({ ...message, content } as unknown as AgentMessage);
    });
}

function makeTools(cwd: string, names: string[]): ToolRegistration[] {
  if (names.some(name => !(DURABLE_AGENT_TOOLS as readonly string[]).includes(name))) {
    throw new Error("This tool is not available in Durable runs");
  }
  const factories = [createReadTool, createBashTool, createEditTool, createWriteTool, createGrepTool, createFindTool, createLsTool];
  return factories.map(create => create(cwd)).filter(tool => names.includes(tool.name)).map(tool => defineTool({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...(READ_ONLY.has(tool.name) ? { replay: "safe" as const } : {}),
    execute: async (args, api, callContext) => {
      // The selected official coding tools retain Pi Web's current file behavior.
      // Writes and shell calls are deliberately never replayed after a crash.
      let previousOutput = "";
      const result = await tool.execute(String(api.taskId), args as never, callContext.abortSignal, update => {
        const text = update.content.filter(block => block.type === "text").map(block => block.text).join("\n");
        if (text) api.output(text.startsWith(previousOutput) ? text.slice(previousOutput.length) : text);
        previousOutput = text;
      });
      return { content: result.content };
    },
  }));
}

async function productionOptions(run: AgentRun) {
  const runtime = await createPiModelRuntime();
  const services = await createAgentSessionServices({ cwd: run.cwd, modelRuntime: runtime });
  const settings = services.settingsManager;
  const provider = run.provider ?? settings.getDefaultProvider();
  const modelId = run.modelId ?? settings.getDefaultModel();
  const model = provider && modelId
    ? runtime.getModel(provider, modelId)
    : (await runtime.getAvailable())[0];
  if (!model) throw new Error("No configured model is available for this Durable run");
  const loader = services.resourceLoader;
  const instructions = [
    loader.getSystemPrompt() ?? "You are a coding assistant. Complete the user's task using the available tools. Report results accurately.",
    ...loader.getAppendSystemPrompt(),
    ...loader.getAgentsFiles().agentsFiles.map(file => `${file.path}\n${file.content}`),
    `Working directory: ${run.cwd}`,
  ].join("\n\n");
  return {
    models: durableModels(runtime), instructions,
    model: { provider: model.provider, modelId: model.id },
    thinkingLevel: run.thinkingLevel ?? settings.getDefaultThinkingLevel() ?? "medium",
  };
}

/** One official Harness and SQLite store per opt-in run. Opening never schedules
 * work: the caller installs cancellation handling before run() admits/resumes it.
 */
export async function openDurableAgentRun(run: AgentRun, options: DurableRunOptions = {}): Promise<DurableRunHandle> {
  const directory = options.directory ?? durableRunDirectory(run.id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let harness: Harness | undefined;
  let root: Conversation | undefined;
  let watcher: Awaited<ReturnType<typeof watchEvents>> | undefined;
  let closed = false;
  let aborted = false;
  let lastError: string | undefined;
  let turns = 0;
  let lastCountedEntry: EntryId | undefined;
  let progressQueue = Promise.resolve();
  let costUsd = 0;
  let reportedUsage: AgentRunReport["usage"] = { inputTokens: 0, outputTokens: 0, cost: 0 };
  const release = await lockfile.lock(directory, {
    realpath: true, stale: 10_000, update: 5_000,
    retries: { retries: 3, minTimeout: 5_000, maxTimeout: 5_000, factor: 1 },
    onCompromised: error => {
      aborted = true;
      lastError = error.message;
      void root?.abort(context, { background: true }).catch(() => {});
    },
  });
  const current = options.currentRun ?? (() => run);
  const checkLimits = async (beforeRequest = false) => {
    const latest = current();
    if (aborted || ["cancelled", "failed", "completed", "interrupted"].includes(latest.status)) {
      throw new Error("Durable run has been stopped");
    }
    if (options.trusted && !await options.trusted()) throw new Error("Workspace is no longer trusted");
    const limits = latest.limits;
    if (beforeRequest && limits?.maxTurns && turns >= limits.maxTurns) throw new Error(`Agent reached the ${limits.maxTurns}-turn limit`);
    if (limits?.maxCostUsd && costUsd >= limits.maxCostUsd) throw new Error(`Agent reached the $${limits.maxCostUsd} cost limit`);
    const timeout = limits?.timeoutMs ?? 24 * 60 * 60_000;
    if (timeout && Date.now() - Date.parse(latest.startedAt ?? latest.createdAt) >= timeout) throw new Error("Agent reached its time limit");
    if (latest.budgetGroup) {
      const spent = readAgentRunStore().runs.filter(item => item.budgetGroup?.id === latest.budgetGroup!.id)
        .reduce((sum, item) => sum + (item.progress?.costUsd ?? item.report?.usage.cost ?? 0), 0);
      if (spent >= latest.budgetGroup.maxCostUsd) throw new Error("Delegation reached its shared cost limit");
    }
  };
  const snapshot = async () => {
    const page = await root!.entries({}, TRANSCRIPT_LIMIT, undefined, context);
    const messages = messagesFrom([...page.items].reverse());
    const transcript: DurableRunTranscript = {
      messages, truncated: page.next !== undefined, updatedAt: new Date().toISOString(),
    };
    const path = join(directory, "transcript.json");
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(transcript), { mode: 0o600 });
    renameSync(temporary, path);
    return messages;
  };
  const updateProgress = async () => {
    // Read committed counters before scheduling, so observer lag and restarts
    // cannot reset a budget. Older entries survive compaction.
    let newTurns = 0;
    let newest = lastCountedEntry;
    let cursor: Parameters<Conversation["entries"]>[2];
    do {
      const page = await root!.entries(lastCountedEntry === undefined ? {} : { minEntryId: lastCountedEntry }, 200, cursor, context);
      if (cursor === undefined) newest = page.items[0]?.id ?? lastCountedEntry;
      newTurns += page.items.reduce((sum, entry) => sum + (entry.id === lastCountedEntry ? 0 : entry.model?.filter(message => message.role === "assistant" && message.stopReason !== "aborted").length ?? 0), 0);
      cursor = page.next;
    } while (cursor !== undefined);
    turns += newTurns;
    lastCountedEntry = newest;
    const usage = await harness!.usage(context);
    reportedUsage = [...Object.values(usage.models), ...Object.values(usage.tools)].reduce((sum, item) => ({
      inputTokens: sum.inputTokens + item.input + item.cacheRead + item.cacheWrite,
      outputTokens: sum.outputTokens + item.output,
      cost: sum.cost + item.cost.total,
    }), { inputTokens: 0, outputTokens: 0, cost: 0 });
    costUsd = reportedUsage.cost;
    options.onProgress?.({ turns, costUsd });
  };
  const progress = () => {
    const next = progressQueue.then(updateProgress);
    progressQueue = next.catch(() => {});
    return next;
  };
  try {
    const config = options.models ? {
      models: options.models, instructions: options.instructions ?? "Complete the task accurately.",
      model: { provider: run.provider!, modelId: run.modelId! }, thinkingLevel: run.thinkingLevel ?? "off",
    } : await productionOptions(run);
    const registry = createRegistry();
    if (options.registry) {
      // Tests supply deterministic official pi-ai providers and controlled tools.
      for (const extension of options.registry.snapshot().installed()) registry.install(extension);
    } else {
      registry.install(defineExtension({ name: "pi-web-tools", tools: makeTools(run.cwd, run.toolNames) }));
    }
    registry.install(defineExtension({
      name: "pi-web-run",
      sections: [section("pi_web_instructions", () => config.instructions, { tag: false })],
      hooks: [
        hook(GenerationTask, { beforeRequest: async () => {
          await progress();
          try { await checkLimits(true); } catch (error) { lastError = (error as Error).message; }
          return undefined;
        } }),
        hook(ToolTask, { beforeTool: async () => {
          await progress();
          try { await checkLimits(); } catch (error) { lastError = (error as Error).message; return { block: lastError }; }
        } }),
      ],
    }));
    const database = join(directory, "agent.sqlite");
    const storage = await openNodeSqliteStorage(database);
    chmodSync(database, 0o600);
    // beforeRequest hooks are advisory in Durable. Enforce the decision at the
    // model boundary as well; throwing from a hook alone does not block a call.
    const guardedModels = new Proxy(config.models, {
      get(target, key) {
        if (key === "streamSimple") return (...args: Parameters<typeof target.streamSimple>) => {
          if (lastError || aborted) throw new Error(lastError ?? "Durable run has been stopped");
          const latest = current();
          if (["cancelled", "failed", "completed", "interrupted"].includes(latest.status)) throw new Error("Durable run has been stopped");
          if (latest.limits?.maxCostUsd && costUsd >= latest.limits.maxCostUsd) throw new Error("Agent reached its cost limit");
          return target.streamSimple(...args);
        };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    try { harness = await Harness.open(storage, { models: guardedModels, registry }, context); }
    catch (error) { await storage.close(context); throw error; }
    root = await harness.root(context, { agent: {
      model: config.model, thinkingLevel: config.thinkingLevel as ModelThinkingLevel,
      cwd: run.cwd,
    } });
    watcher = await watchEvents(harness, root.id, context);
    await progress();
    await snapshot();
    watcher.start(async events => {
      let changed = false;
      for (const event of events) {
        if (event.type === "snapshot") { changed = true; continue; }
        if (event.type === "message_end") {
          changed = true;
        }
        if (event.type === "task_failed") lastError = event.message;
      }
      if (changed) { await progress(); await snapshot(); }
    });
    return {
      async run() {
        if (closed || aborted) throw new Error("Durable run has been stopped");
        // Admission retries after process death resolve the original submission.
        const submission = await root!.submit({ type: "input", content: run.prompt, requestId: run.id }, context);
        const settled = await submission.wait(context);
        const messages = await snapshot();
        await progress();
        return { messages, usage: reportedUsage, ...(settled.status === "unanswered" || lastError ? { error: lastError ?? (settled.status === "unanswered" ? settled.reason : "Run failed") } : {}) };
      },
      async abort() {
        aborted = true;
        if (!closed) await root!.abort(context, { background: true });
      },
      async close() {
        if (closed) return;
        closed = true;
        try {
          await watcher?.stop();
          await harness!.close(context);
        } finally { await release(); }
      },
    };
  } catch (error) {
    try { await watcher?.stop(); await harness?.close(context); } finally { await release(); }
    throw error;
  }
}
