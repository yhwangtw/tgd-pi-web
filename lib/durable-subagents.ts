import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai-durable";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  configure, defineDoc, defineExtension, defineTool, GenerationTask, hook, ToolTask, UsageDoc,
  type ConversationId, type Cursor, type Extension, type Harness, type HookApi,
  type JsonObject, type ModelRef, type TaskId, type ToolExecutionApi, type UsageState,
} from "@earendil-works/pi-durable";
import { allocateRunLimits } from "./agent-run-limits";
import { buildAgentRunReport } from "./agent-run-report";
import { readAgentRunStore } from "./agent-run-store";
import { normalizeToolCalls } from "./normalize";
import {
  BUILTIN_SUBAGENTS, composeSubagentPrompt, discoverSubagents,
  type SubagentDefinition, type SubagentScope,
} from "./subagent-extension";
import type { AgentRunLimits, AgentRunReport } from "./agent-run-types";
import type { AgentMessage } from "./types";

type Limits = { maxTurns: number; maxCostUsd: number; timeoutMs: number };
type Mode = "single" | "parallel" | "chain";
type ChildState = {
  ownerTaskId: number; parentConversationId: number; index: number;
  agent: string; source: string; task: string; cwd: string; tools: string[];
  limits: Limits; startedAt: number; finishedAt: number; status: string; error: string;
  turns: number; modelCost: number; responses: Record<string, true>;
};

/** Metadata belongs to the conversation; a fork never inherits delegation rights. */
export const DurableSubagentDoc = defineDoc({
  kind: "pi-web.durable-subagent", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: (): ChildState => ({
    ownerTaskId: 0, parentConversationId: 0, index: -1, agent: "", source: "", task: "", cwd: "", tools: [],
    limits: { maxTurns: 0, maxCostUsd: 0, timeoutMs: 0 }, startedAt: 0, finishedAt: 0,
    status: "queued", error: "", turns: 0, modelCost: 0, responses: {},
  }),
});

const DelegationDoc = defineDoc({
  kind: "pi-web.durable-delegation", version: 1, scope: "task",
  initial: () => ({ startedAt: 0, limits: { maxTurns: 0, maxCostUsd: 0, timeoutMs: 0 },
    children: {} as Record<string, number>, reservations: {} as Record<string, number> }),
});

export interface DurableSubagentChild {
  conversationId: number;
  parentConversationId: number;
  ownerTaskId: number;
  index: number;
  agent: string;
  source: string;
  task: string;
  cwd: string;
  tools: string[];
  limits: AgentRunLimits;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  report?: AgentRunReport;
}

export interface DurableSubagentOptions {
  sessionId?: (conversationId: number) => string;
  /** The single host Harness, assigned after Harness.open(). */
  getHarness: () => Harness;
  readLimits?: () => AgentRunLimits;
  readConcurrency?: () => number;
  isProjectTrusted?: (cwd: string) => boolean | Promise<boolean>;
  discover?: typeof discoverSubagents;
  /** Prepare host services after configuration, before a child can execute. */
  beforeChild?: (conversationId: number) => void | Promise<void>;
  /** Projection only: the callback must not schedule a second runtime. */
  onChild?: (child: DurableSubagentChild) => void | Promise<void>;
}

type SlotWaiter = { limit: () => number; signal?: AbortSignal; accept: (release: () => void) => void; reject: (error: unknown) => void; abort: () => void };
const pool = {
  active: 0,
  waiting: [] as SlotWaiter[],
  pump() {
    for (let index = 0; index < this.waiting.length;) {
      const waiter = this.waiting[index];
      if (this.active >= waiter.limit()) { index++; continue; }
      this.waiting.splice(index, 1);
      waiter.signal?.removeEventListener("abort", waiter.abort);
      this.active++;
      let released = false;
      waiter.accept(() => { if (!released) { released = true; this.active--; this.pump(); } });
    }
  },
  acquire(limit: () => number, signal?: AbortSignal): Promise<() => void> {
    return new Promise((accept, reject) => {
      const waiter: SlotWaiter = { limit, signal, accept, reject, abort: () => {
        this.waiting = this.waiting.filter(item => item !== waiter);
        reject(signal?.reason ?? new Error("Delegation cancelled"));
      } };
      if (signal?.aborted) { waiter.abort(); return; }
      signal?.addEventListener("abort", waiter.abort, { once: true });
      this.waiting.push(waiter);
      this.pump();
    });
  },
};

const Allocation = Type.Object({
  maxTurns: Type.Optional(Type.Integer({ minimum: 0 })),
  maxCostUsd: Type.Optional(Type.Number({ minimum: 0 })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 2_147_483_647 })),
});
const Item = Type.Object({
  agent: Type.String({ minLength: 1, maxLength: 80 }), task: Type.String({ minLength: 1, maxLength: 100_000 }),
  tools: Type.Optional(Type.Array(Type.String())), limits: Type.Optional(Allocation),
});
const Params = Type.Object({
  agent: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  task: Type.Optional(Type.String({ minLength: 1, maxLength: 100_000 })),
  tools: Type.Optional(Type.Array(Type.String())), limits: Type.Optional(Allocation),
  tasks: Type.Optional(Type.Array(Item, { minItems: 1, maxItems: 8 })),
  chain: Type.Optional(Type.Array(Item, { minItems: 1, maxItems: 8 })),
  agentScope: Type.Optional(Type.Union([Type.Literal("builtin"), Type.Literal("user"), Type.Literal("project"), Type.Literal("all")])),
  confirmProjectAgents: Type.Optional(Type.Boolean({ default: true })),
});

function limits(configured: AgentRunLimits, requested?: AgentRunLimits): Limits {
  return allocateRunLimits(configured, requested) as Limits;
}

function usage(state: Readonly<UsageState> | undefined) {
  const total = { inputTokens: 0, outputTokens: 0, cost: 0, modelCost: 0 };
  for (const [kind, bucket] of Object.entries(state ?? {})) for (const item of Object.values(bucket)) {
    total.inputTokens += item.input + item.cacheRead + item.cacheWrite;
    total.outputTokens += item.output;
    total.cost += item.cost.total;
    if (kind === "models") total.modelCost += item.cost.total;
  }
  return total;
}

function clipped(value: string) {
  const bytes = Buffer.from(value);
  if (bytes.length <= 50 * 1024) return value;
  let end = 50 * 1024;
  while ((bytes[end] & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString("utf8")}\n\n[Output truncated to 50 KB.]`;
}

function model(configured: string | undefined, inherited: ModelRef | undefined): ModelRef | undefined {
  if (!configured) return inherited;
  const slash = configured.indexOf("/");
  return slash > 0 ? { provider: configured.slice(0, slash), modelId: configured.slice(slash + 1) }
    : inherited ? { provider: inherited.provider, modelId: configured } : undefined;
}

type ResolvedItem = { definition: SubagentDefinition; task: string; tools: string[]; limits: Limits; model?: ModelRef };
type ResolvedPlan = { mode: Mode; cwd: string; limits: Limits; startedAt: number; items: ResolvedItem[] };
type Outcome = { child: DurableSubagentChild; output: string };

/** Uses native task-owned conversations and persisted receipts, never the legacy
 * supervisor. All mutable state needed after a crash belongs to this Harness. */
export function createDurableSubagentExtension(options: DurableSubagentOptions): Extension & {
  checkExecution(api: ToolExecutionApi, context: Context): Promise<void>;
} {
  const readLimits = options.readLimits ?? (() => readAgentRunStore().subagentLimits ?? {});
  const concurrency = () => {
    const value = options.readConcurrency?.() ?? readAgentRunStore().maxConcurrency ?? 3;
    return Number.isFinite(value) ? Math.max(1, Math.min(8, Math.floor(value))) : 3;
  };
  const trusted = options.isProjectTrusted ?? (cwd => SettingsManager.create(cwd).isProjectTrusted());
  const discover = options.discover ?? discoverSubagents;
  const leases = new Map<ConversationId, Promise<() => void>>();
  const deadlines = new Map<ConversationId, ReturnType<typeof setTimeout>>();
  const preparations = new Map<ConversationId, Promise<void>>();
  let subscribed: Harness | undefined;
  let closing = false;
  const host = () => {
    const harness = options.getHarness();
    if (subscribed !== harness) {
      subscribed = harness;
      closing = false;
      harness.subscribeClose(() => {
        closing = true;
        for (const timer of deadlines.values()) clearTimeout(timer);
        deadlines.clear();
        for (const release of leases.values()) void release.then(done => done(), () => {});
        leases.clear();
        preparations.clear();
      });
    }
    return harness;
  };
  const prepare = (id: ConversationId) => {
    host();
    let pending = preparations.get(id);
    if (!pending) {
      pending = Promise.resolve().then(() => options.beforeChild?.(id));
      preparations.set(id, pending);
    }
    return pending;
  };
  const release = async (id: ConversationId) => {
    const held = leases.get(id);
    leases.delete(id);
    if (held) await held.then(done => done(), () => {});
    const timer = deadlines.get(id);
    if (timer) clearTimeout(timer);
    deadlines.delete(id);
  };
  const acquire = (id: ConversationId, context: Context) => {
    host();
    let held = leases.get(id);
    if (!held) {
      held = pool.acquire(concurrency, context.abortSignal);
      leases.set(id, held);
      held.catch(() => { if (leases.get(id) === held) leases.delete(id); });
    }
    return held;
  };
  const notify = async (child: DurableSubagentChild) => {
    // Dashboard failure cannot make a successful durable task run again.
    try { await options.onChild?.(child); } catch { /* projection can be rebuilt */ }
  };
  const projection = (id: ConversationId, saved: Readonly<ChildState>, report?: AgentRunReport): DurableSubagentChild => ({
    conversationId: id, parentConversationId: saved.parentConversationId, ownerTaskId: saved.ownerTaskId,
    index: saved.index, agent: saved.agent, source: saved.source, task: saved.task, cwd: saved.cwd,
    tools: [...saved.tools], limits: { ...saved.limits }, status: saved.status as DurableSubagentChild["status"],
    ...(saved.startedAt ? { startedAt: new Date(saved.startedAt).toISOString() } : {}),
    ...(saved.finishedAt ? { finishedAt: new Date(saved.finishedAt).toISOString() } : {}),
    ...(saved.error ? { error: saved.error } : {}), ...(report ? { report } : {}),
  });
  const stop = async (id: ConversationId, reason: string) => {
    const harness = host();
    await harness.commit(async tx => {
      const child = await tx.doc(DurableSubagentDoc, id);
      if (child.status !== "completed") { child.error = reason; child.status = "failed"; }
    }, BACKGROUND_CONTEXT);
    await (await harness.conversation(id, BACKGROUND_CONTEXT))?.abort(BACKGROUND_CONTEXT, { background: true });
  };
  const armDeadline = async (id: ConversationId, context: Context) => {
    if (deadlines.has(id)) return;
    const harness = host();
    const child = await harness.snapshot(DurableSubagentDoc, id, context);
    if (!child?.ownerTaskId) return;
    const group = await harness.snapshot(DelegationDoc, child.ownerTaskId as TaskId, context);
    const caps = limits(child.limits, readLimits());
    const groupCaps = limits(group?.limits ?? {}, readLimits());
    const due = Math.min(caps.timeoutMs ? child.startedAt + caps.timeoutMs : Infinity,
      groupCaps.timeoutMs ? (group?.startedAt ?? child.startedAt) + groupCaps.timeoutMs : Infinity);
    if (!Number.isFinite(due)) return;
    const timer = setTimeout(() => { void stop(id, "Delegation reached its time limit").catch(() => {}); }, Math.max(0, due - Date.now()));
    timer.unref?.();
    deadlines.set(id, timer);
  };

  // Generation hooks are advisory upstream. To block a call, first persist the
  // official abort mark and wait for its signal; only then may the hook reject.
  const abortRequest = async (api: HookApi, context: Context, reason: string): Promise<never> => {
    await host().commit(async tx => {
      const child = await tx.doc(DurableSubagentDoc, api.conversationId);
      child.error = reason; child.status = "failed";
    }, context);
    return new Promise<never>((_resolve, reject) => {
      const aborted = () => reject(new Error(reason));
      if (context.abortSignal?.aborted) { aborted(); return; }
      context.abortSignal?.addEventListener("abort", aborted, { once: true });
      void host().abortTask(api.taskId, BACKGROUND_CONTEXT).then(() => {
        context.abortSignal?.removeEventListener("abort", aborted);
        aborted();
      }, reject);
    });
  };

  const budget = async (api: HookApi, context: Context, reserve: boolean): Promise<string | undefined> => {
    const harness = host();
    const saved = await harness.snapshot(DurableSubagentDoc, api.conversationId, context);
    if (!saved?.ownerTaskId) return;
    if (!await trusted(saved.cwd)) return "Workspace is no longer trusted";
    const configured = readLimits();
    return harness.commit(async tx => {
      const child = await tx.doc(DurableSubagentDoc, api.conversationId);
      const group = await tx.doc(DelegationDoc, child.ownerTaskId as TaskId);
      const childCaps = limits(child.limits, configured);
      const groupCaps = limits(group.limits, configured);
      if (child.error) return child.error;
      if (childCaps.timeoutMs && Date.now() - child.startedAt >= childCaps.timeoutMs
        || groupCaps.timeoutMs && Date.now() - group.startedAt >= groupCaps.timeoutMs) return "Delegation reached its time limit";
      let groupTurns = 0, groupCost = 0, childCost = 0;
      for (const id of Object.values(group.children)) {
        const member = await tx.doc(DurableSubagentDoc, id as ConversationId);
        const ledger = usage(await tx.doc(UsageDoc, id as ConversationId));
        const cost = Math.max(ledger.modelCost, member.modelCost) + ledger.cost - ledger.modelCost;
        groupTurns += member.turns; groupCost += cost;
        if (id === api.conversationId) childCost = cost;
      }
      if (childCaps.maxCostUsd && childCost >= childCaps.maxCostUsd
        || groupCaps.maxCostUsd && groupCost >= groupCaps.maxCostUsd) return "Delegation reached its shared cost limit";
      if (reserve) {
        const otherReservations = Object.entries(group.reservations).filter(([key]) => key !== String(api.taskId));
        if (childCaps.maxTurns && child.turns + otherReservations.filter(([, id]) => id === api.conversationId).length >= childCaps.maxTurns
          || groupCaps.maxTurns && groupTurns + otherReservations.length >= groupCaps.maxTurns) return "Delegation reached its shared turn limit";
        group.reservations[String(api.taskId)] = api.conversationId;
      }
      return undefined;
    }, context);
  };

  const report = async (id: ConversationId, saved: Readonly<ChildState>, context: Context) => {
    const conversation = await host().conversation(id, context);
    if (!conversation) throw new Error("Delegated conversation is missing");
    const entries = [];
    let cursor: Cursor | undefined;
    do {
      const page = await conversation.entries({}, 200, cursor, context);
      entries.push(...page.items); cursor = page.next;
    } while (cursor !== undefined);
    const messages = entries.reverse().flatMap(entry => entry.model ?? []).filter(message => message.role !== "system")
      .map(message => normalizeToolCalls(message as unknown as AgentMessage));
    const summary = buildAgentRunReport(messages, saved.startedAt ? new Date(saved.startedAt).toISOString() : undefined);
    const total = usage(await host().snapshot(UsageDoc, id, context));
    summary.usage = { inputTokens: total.inputTokens, outputTokens: total.outputTokens, cost: total.cost };
    const last = messages.findLast(message => message.role === "assistant");
    const output = last?.role === "assistant" ? last.content.filter(block => block.type === "text").map(block => block.type === "text" ? block.text : "").join("\n").trim() : "";
    return { report: summary, output: clipped(output || saved.error || summary.summary) };
  };

  const details = (mode: Mode, outcomes: Outcome[], caps: Limits) => ({
    mode, limits: caps,
    runs: outcomes.map(({ child }) => ({ ...child, runId: options.sessionId?.(child.conversationId) ?? `durable:${child.conversationId}`, sessionId: options.sessionId?.(child.conversationId) ?? String(child.conversationId) })),
    // Child usage is already in Harness.usage(). Returning ToolResult.usage
    // again would charge/count it twice; preserve it only in report/details.
    usage: outcomes.reduce((total, { child }) => ({ inputTokens: total.inputTokens + (child.report?.usage.inputTokens ?? 0),
      outputTokens: total.outputTokens + (child.report?.usage.outputTokens ?? 0), cost: total.cost + (child.report?.usage.cost ?? 0) }),
    { inputTokens: 0, outputTokens: 0, cost: 0 }),
  });

  const runChild = async (plan: ResolvedPlan, index: number, task: string, api: ToolExecutionApi, context: Context): Promise<Outcome> => {
    const item = plan.items[index];
    const id = await api.commit(async tx => {
      const group = await tx.doc(DelegationDoc, api.taskId);
      if (group.children[String(index)]) return group.children[String(index)] as ConversationId;
      const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
      const registered = new Map(api.registry.tools().map(({ tool }) => [tool.name, tool]));
      await configure(tx, created.id, { model: item.model, cwd: plan.cwd,
        tools: item.tools.flatMap(name => registered.has(name) ? [registered.get(name)!] : []) });
      const child = await tx.doc(DurableSubagentDoc, created.id);
      Object.assign(child, { ownerTaskId: api.taskId, parentConversationId: api.conversationId, index,
        agent: item.definition.name, source: item.definition.source, task, cwd: plan.cwd, tools: item.tools, limits: item.limits });
      group.children[String(index)] = created.id;
      return created.id;
    }, context);
    let saved = (await api.snapshot(DurableSubagentDoc, id, context))!;
    await notify(projection(id, saved));
    // A completed chain link is read, never re-submitted or recomputed.
    if (saved.status === "completed" || saved.status === "failed" || saved.status === "cancelled") {
      const result = await report(id, saved, context);
      return { child: projection(id, saved, result.report), output: result.output };
    }
    try {
      await acquire(id, context);
      await api.commit(async tx => {
        const child = await tx.doc(DurableSubagentDoc, id);
        child.startedAt ||= Date.now(); child.status = "running";
      }, context);
      await armDeadline(id, context);
      saved = (await api.snapshot(DurableSubagentDoc, id, context))!;
      await notify(projection(id, saved));
      const child = await api.conversation(id, context);
      if (!child) throw new Error("Delegated conversation is missing");
      await prepare(id);
      const submission = await child.submit({ type: "input", requestId: `subagent:${api.taskId}:${index}`,
        content: composeSubagentPrompt(item.definition, saved.task) }, context);
      const settled = await submission.wait(context);
      await api.commit(async tx => {
        const stored = await tx.doc(DurableSubagentDoc, id);
        stored.status = stored.error ? "failed" : settled.status === "done" ? "completed" : settled.reason === "aborted" ? "cancelled" : "failed";
        if (settled.status === "unanswered" && !stored.error) stored.error = settled.reason;
        stored.finishedAt = Date.now();
        const group = await tx.doc(DelegationDoc, api.taskId);
        for (const [key, childId] of Object.entries(group.reservations)) if (childId === id) delete group.reservations[key];
      }, context);
      saved = (await api.snapshot(DurableSubagentDoc, id, context))!;
      const result = await report(id, saved, context);
      const projected = projection(id, saved, result.report);
      await notify(projected);
      return { child: projected, output: result.output };
    } catch (error) {
      if (context.abortSignal?.aborted && !closing) {
        await host().commit(async tx => {
          const child = await tx.doc(DurableSubagentDoc, id);
          if (!child.error) { child.status = "cancelled"; child.error = "Parent delegation was cancelled"; }
          child.finishedAt = Date.now();
        }, BACKGROUND_CONTEXT);
        const cancelled = await host().snapshot(DurableSubagentDoc, id, BACKGROUND_CONTEXT);
        if (cancelled) await notify(projection(id, cancelled));
      }
      if (!context.abortSignal?.aborted && !closing) {
        await api.commit(async tx => {
          const child = await tx.doc(DurableSubagentDoc, id);
          child.status = "failed"; child.error ||= error instanceof Error ? error.message : String(error);
          child.finishedAt = Date.now();
        }, context);
        saved = (await api.snapshot(DurableSubagentDoc, id, context))!;
        const result = await report(id, saved, context);
        const projected = projection(id, saved, result.report);
        await notify(projected);
        return { child: projected, output: result.output };
      }
      throw error;
    } finally { await release(id); }
  };

  const extension = defineExtension({
    name: "pi-web-durable-subagent",
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async (_request, api, context) => {
          const saved = await api.snapshot(DurableSubagentDoc, api.conversationId, context);
          if (!saved?.ownerTaskId) return;
          try {
            await acquire(api.conversationId, context);
            await armDeadline(api.conversationId, context);
            await prepare(api.conversationId);
            const reason = await budget(api, context, true);
            if (reason) await abortRequest(api, context, reason);
          } catch (error) {
            if (!context.abortSignal?.aborted) await abortRequest(api, context,
              `Delegation guard failed: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
          }
          return undefined;
        },
        afterResponse: async (message, api, context) => {
          const saved = await api.snapshot(DurableSubagentDoc, api.conversationId, context);
          if (!saved?.ownerTaskId) return;
          const key = `${api.taskId}:${createHash("sha256").update(JSON.stringify(message)).digest("hex")}`;
          await host().commit(async tx => {
            const child = await tx.doc(DurableSubagentDoc, api.conversationId);
            if (!child.responses[key]) { child.responses[key] = true; child.turns++; child.modelCost += message.usage.cost.total; }
            delete (await tx.doc(DelegationDoc, child.ownerTaskId as TaskId)).reservations[String(api.taskId)];
          }, context);
        },
      }),
      hook(ToolTask, { beforeTool: async (call, api, context) => {
        const saved = await api.snapshot(DurableSubagentDoc, api.conversationId, context);
        if (!saved?.ownerTaskId) return;
        if (call.name === "subagent" || !saved.tools.includes(call.name)) return { block: "Subagent cannot expand its delegated tool permissions" };
        try {
          await prepare(api.conversationId);
          const reason = await budget(api, context, false);
          return reason ? { block: reason } : undefined;
        } catch (error) {
          return { block: `Delegation guard failed: ${error instanceof Error ? error.message : String(error)}` };
        }
      } }),
    ],
    tools: [defineTool({
      name: "subagent", description: `Delegate single (agent + task), parallel (tasks), or chain (chain; {previous} inserts prior output) work to durable child conversations. Agents: ${BUILTIN_SUBAGENTS.map(agent => `${agent.name}: ${agent.description}`).join("; ")}. Children share cwd, inherit only permitted tools, cannot recursively delegate, and share the request's user limits.`,
      parameters: Params, replay: "safe", executionMode: "sequential",
      execute: async (params, api, context) => {
        if ((await api.snapshot(DurableSubagentDoc, api.conversationId, context))?.ownerTaskId) throw new Error("Recursive delegation is disabled");
        let plan = await api.memo<JsonObject>("resolved-delegation", context) as unknown as ResolvedPlan | undefined;
        if (!plan) {
          const count = Number(Boolean(params.agent && params.task)) + Number(Boolean(params.tasks?.length)) + Number(Boolean(params.chain?.length));
          if (count !== 1) throw new Error("Provide exactly one subagent mode: agent + task, tasks, or chain");
          const parent = await api.agent(context);
          if (!parent.cwd) throw new Error("A workspace is required for delegation");
          if (!await trusted(parent.cwd)) throw new Error("Workspace is not trusted for delegation");
          const mode: Mode = params.tasks ? "parallel" : params.chain ? "chain" : "single";
          const requested = params.tasks ?? params.chain ?? [{ agent: params.agent!, task: params.task!, tools: params.tools, limits: params.limits }];
          const definitions = new Map(discover(parent.cwd, (params.agentScope ?? "builtin") as SubagentScope).map(agent => [agent.name, agent]));
          const caps = limits(readLimits(), params.limits);
          const parentTools = parent.tools.map(tool => tool.name).filter(name => name !== "subagent");
          const items = requested.map(item => {
            const definition = definitions.get(item.agent);
            if (!definition) throw new Error(`Unknown subagent: ${item.agent}`);
            const tools = (definition.inheritTools ? parentTools : definition.tools).filter(name => parentTools.includes(name)
              && (!params.tools || params.tools.includes(name)) && (!item.tools || item.tools.includes(name)) && name !== "subagent");
            return { definition, task: item.task, tools: [...new Set(tools)], limits: limits(caps, item.limits), model: model(definition.model, parent.model) };
          });
          const candidate: ResolvedPlan = { mode, cwd: parent.cwd, startedAt: Date.now(), limits: caps, items };
          plan = await api.memo("resolved-delegation", JSON.parse(JSON.stringify(candidate)) as JsonObject, context) as unknown as ResolvedPlan;
        }
        const resolved = plan;
        await api.commit(async tx => {
          const group = await tx.doc(DelegationDoc, api.taskId);
          if (!group.startedAt) { group.startedAt = resolved.startedAt; group.limits = resolved.limits; }
        }, context);
        const outcomes: Outcome[] = [];
        const run = async (index: number, task: string) => {
          const outcome = await runChild(resolved, index, task, api, context);
          outcomes[index] = outcome;
          await api.details(JSON.parse(JSON.stringify(details(resolved.mode, outcomes.filter(Boolean), resolved.limits))), context);
          return outcome;
        };
        if (resolved.mode === "parallel") {
          await Promise.all(resolved.items.map((item, index) => run(index, item.task)));
        } else {
          let previous = "";
          for (let index = 0; index < resolved.items.length; index++) {
            const outcome = await run(index, resolved.items[index].task.replace(/\{previous\}/g, previous));
            previous = outcome.output;
            if (outcome.child.status !== "completed") break;
          }
        }
        const failed = outcomes.some(outcome => outcome.child.status !== "completed");
        const output = resolved.mode === "parallel"
          ? `${outcomes.filter(outcome => outcome.child.status === "completed").length}/${resolved.items.length} subagents completed\n\n${outcomes.map(outcome => `### ${outcome.child.agent} · ${outcome.child.status}\n\n${outcome.output}`).join("\n\n---\n\n")}`
          : failed ? `Chain stopped at ${outcomes.at(-1)!.child.agent}: ${outcomes.at(-1)!.child.error || outcomes.at(-1)!.output}` : outcomes.at(-1)?.output ?? "No output.";
        return { content: [{ type: "text", text: clipped(output) }],
          details: JSON.parse(JSON.stringify(details(resolved.mode, outcomes, resolved.limits))), ...(failed ? { isError: true } : {}) };
      },
    })],
  });
  return Object.assign(extension, {
    // Native replay of an already-admitted safe tool skips beforeTool entirely.
    // Hosts wrap execute with this check so revocations also apply after recovery.
    async checkExecution(api: ToolExecutionApi, context: Context): Promise<void> {
      const saved = await api.snapshot(DurableSubagentDoc, api.conversationId, context);
      if (!saved?.ownerTaskId) return;
      await prepare(api.conversationId);
      const reason = await budget(api, context, false);
      if (reason) throw new Error(reason);
    },
  });
}
