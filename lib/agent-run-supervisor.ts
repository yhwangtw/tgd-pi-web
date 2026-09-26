import { randomUUID } from "node:crypto";
import { startRpcSession, type AgentEvent, type AgentSessionWrapper } from "./rpc-manager";
import {
  mutateAgentRunStore,
  readAgentRunStore,
  reconcileInterruptedAgentRuns,
} from "./agent-run-store";
import {
  DEFAULT_AGENT_RUN_CONCURRENCY,
  isAgentRunConcurrency,
  MAX_AGENT_RUN_CONCURRENCY,
  MIN_AGENT_RUN_CONCURRENCY,
  TERMINAL_AGENT_RUN_STATUSES,
  type AgentRun,
  type AgentRunCompletion,
  type AgentRunInput,
  type AgentRunStatus,
} from "./agent-run-types";
import type { WebExtensionUIEvent } from "./web-extension-ui";
import { isWebExtensionUIDialogRequest, isWebExtensionUIEvent } from "./web-extension-ui-types";
import { isTrustedAgentRunWorkspace } from "./agent-run-workspace";
import { buildAgentRunReport } from "./agent-run-report";
import type { AgentMessage } from "./types";
import { approachingRunLimit, isAgentRunLimits } from "./agent-run-limits";
import type { AgentRunLimits } from "./agent-run-types";

const KEEP_ALIVE_MS = 30_000;
const MAX_RUN_MS = 24 * 60 * 60_000;

interface ActiveRun {
  run: AgentRun;
  messages: AgentMessage[];
  session: AgentSessionWrapper | null;
  unsubscribe: (() => void) | null;
  keepAlive: ReturnType<typeof setInterval> | null;
  timeout: ReturnType<typeof setTimeout> | null;
  pendingDialogs: Set<string>;
  turns: number;
  costUsd: number;
}

interface RunWaiter {
  resolve: (completion: AgentRunCompletion) => void;
  onUpdate?: (run: AgentRun) => void;
  removeAbortListener?: () => void;
}

export class AgentRunNotFoundError extends Error {}
export class AgentRunConflictError extends Error {}

function configuredConcurrency(): number {
  const parsed = Number.parseInt(process.env.PIWEB_AGENT_CONCURRENCY ?? "", 10);
  return Number.isFinite(parsed)
    ? Math.max(MIN_AGENT_RUN_CONCURRENCY, Math.min(MAX_AGENT_RUN_CONCURRENCY, parsed))
    : DEFAULT_AGENT_RUN_CONCURRENCY;
}

function eventRunError(event: AgentEvent): string | null {
  if (event.type !== "agent_end" || !Array.isArray(event.messages)) return null;
  const messages = event.messages as Array<{ role?: string; stopReason?: string; errorMessage?: string }>;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    if (message.stopReason === "error") return message.errorMessage || "Model call failed";
    if (message.stopReason === "aborted") return "The agent run was aborted";
    return null;
  }
  return null;
}

function cloneRun(run: AgentRun): AgentRun {
  return structuredClone(run);
}

export class AgentRunSupervisor {
  private maxConcurrencyValue: number;
  private readonly active = new Map<string, ActiveRun>();
  private readonly waiters = new Map<string, RunWaiter>();
  private started = false;
  private draining = false;

  constructor(options: { maxConcurrency?: number } = {}) {
    const persisted = options.maxConcurrency === undefined
      ? readAgentRunStore().maxConcurrency
      : undefined;
    this.maxConcurrencyValue = options.maxConcurrency ?? persisted ?? configuredConcurrency();
  }

  get maxConcurrency(): number {
    return this.maxConcurrencyValue;
  }

  setSubagentLimits(limits: AgentRunLimits): void {
    if (!isAgentRunLimits(limits)) throw new RangeError("Invalid subagent limits");
    mutateAgentRunStore((store) => { store.subagentLimits = { ...limits }; });
  }

  extend(runId: string): AgentRun {
    const active = this.active.get(runId);
    if (!active) throw new AgentRunConflictError("Only active runs can be extended");
    const current = active.run.limits ?? {};
    const limits = {
      ...current,
      ...(current.maxTurns ? { maxTurns: Math.min(Number.MAX_SAFE_INTEGER, Math.max(current.maxTurns * 2, active.turns + 24)) } : {}),
      ...(current.maxCostUsd ? { maxCostUsd: Math.min(Number.MAX_VALUE, Math.max(current.maxCostUsd * 2, active.costUsd + 5)) } : {}),
      timeoutMs: current.timeoutMs === 0 ? 0 : Math.min(2_147_483_647, (current.timeoutMs ?? MAX_RUN_MS) + 30 * 60_000),
    };
    const group = active.run.budgetGroup
      ? { ...active.run.budgetGroup, maxCostUsd: Math.min(Number.MAX_VALUE, active.run.budgetGroup.maxCostUsd * 2) }
      : undefined;
    const updated = this.updateRun(runId, active.pendingDialogs.size ? "waiting_for_input" : "running", {
      limits, limitWarning: false, ...(group ? { budgetGroup: group } : {}),
    });
    if (!updated) throw new AgentRunConflictError("Run has already finished");
    if (group) for (const member of this.active.values()) {
      if (member.run.budgetGroup?.id === group.id) member.run.budgetGroup = { ...group };
    }
    active.run.limits = limits;
    active.run.limitWarning = false;
    this.armDeadline(active);
    return updated;
  }

  private publishProgress(active: ActiveRun): void {
    const group = active.run.budgetGroup;
    const groupCost = group ? this.groupCost(active.run) - (active.run.progress?.costUsd ?? 0) + active.costUsd : 0;
    const warning = approachingRunLimit(active.run.limits, active.turns, active.costUsd, Date.now() - Date.parse(active.run.startedAt!))
      || (!!group && groupCost >= group.maxCostUsd * .8);
    if (warning !== !!active.run.limitWarning || active.run.progress?.turns !== active.turns) {
      active.run.limitWarning = warning;
      active.run.progress = { turns: active.turns, costUsd: active.costUsd };
      this.updateRun(active.run.id, active.pendingDialogs.size ? "waiting_for_input" : "running", { limitWarning: warning, progress: active.run.progress });
    }
  }

  private armDeadline(active: ActiveRun): void {
    if (active.timeout) clearTimeout(active.timeout);
    const timeoutMs = active.run.limits?.timeoutMs ?? MAX_RUN_MS;
    if (timeoutMs === 0) { active.timeout = null; return; }
    const remaining = Math.max(1, timeoutMs - (Date.now() - Date.parse(active.run.startedAt!)));
    active.timeout = setTimeout(() => {
      void active.session?.send({ type: "abort" }).catch(() => {});
      this.finish(active.run.id, "failed", "Agent run reached its time limit; results remain in the session", active.messages);
    }, remaining);
    active.timeout.unref?.();
  }

  setMaxConcurrency(value: number): number {
    if (!isAgentRunConcurrency(value)) {
      throw new RangeError(
        `maxConcurrency must be an integer between ${MIN_AGENT_RUN_CONCURRENCY} and ${MAX_AGENT_RUN_CONCURRENCY}`,
      );
    }
    mutateAgentRunStore((store) => {
      store.maxConcurrency = value;
    });
    this.maxConcurrencyValue = value;
    this.drain();
    return value;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    reconcileInterruptedAgentRuns();
    this.drain();
  }

  private createQueuedRun(input: AgentRunInput, options: {
    trigger?: AgentRun["trigger"];
    parentRunId?: string;
  } = {}): AgentRun {
    const now = new Date().toISOString();
    const run: AgentRun = {
      ...input,
      id: randomUUID(),
      trigger: options.trigger ?? "manual",
      status: "queued",
      createdAt: now,
      ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
    };
    mutateAgentRunStore((store) => {
      // A user extension also applies to later chain steps/retries in this group.
      const group = run.budgetGroup && store.runs.find(item => item.budgetGroup?.id === run.budgetGroup!.id)?.budgetGroup;
      if (group) run.budgetGroup = { ...group };
      store.runs.unshift(run);
    });
    return cloneRun(run);
  }

  enqueue(input: AgentRunInput, options: {
    trigger?: AgentRun["trigger"];
    parentRunId?: string;
  } = {}): AgentRun {
    const run = this.createQueuedRun(input, options);
    this.drain();
    return run;
  }

  enqueueAndWait(input: AgentRunInput, options: {
    trigger?: AgentRun["trigger"];
    parentRunId?: string;
    signal?: AbortSignal;
    onUpdate?: (run: AgentRun) => void;
  } = {}): Promise<AgentRunCompletion> {
    if (options.signal?.aborted) {
      return Promise.reject(new Error("Agent run was cancelled before it started"));
    }
    const run = this.createQueuedRun(input, options);
    return new Promise<AgentRunCompletion>((resolve) => {
      const waiter: RunWaiter = { resolve, onUpdate: options.onUpdate };
      if (options.signal) {
        const abort = () => { void this.cancel(run.id); };
        options.signal.addEventListener("abort", abort, { once: true });
        waiter.removeAbortListener = () => options.signal?.removeEventListener("abort", abort);
      }
      this.waiters.set(run.id, waiter);
      options.onUpdate?.(run);
      this.drain();
    });
  }

  retry(runId: string): AgentRun {
    const original = readAgentRunStore().runs.find((run) => run.id === runId);
    if (!original) throw new AgentRunNotFoundError("Agent run not found");
    if (!TERMINAL_AGENT_RUN_STATUSES.has(original.status)) {
      throw new AgentRunConflictError("Only terminal runs can be retried");
    }
    return this.enqueue({
      name: original.name,
      cwd: original.cwd,
      prompt: original.prompt,
      provider: original.provider,
      modelId: original.modelId,
      thinkingLevel: original.thinkingLevel,
      toolNames: [...original.toolNames],
      workspace: original.workspace ? { ...original.workspace } : undefined,
      limits: original.limits ? { ...original.limits } : undefined,
      budgetGroup: original.budgetGroup ? { ...original.budgetGroup } : undefined,
    }, {
      trigger: "retry",
      parentRunId: original.id,
    });
  }

  async cancel(runId: string): Promise<AgentRun> {
    const result = mutateAgentRunStore((store) => {
      const run = store.runs.find((item) => item.id === runId);
      if (!run) return null;
      if (TERMINAL_AGENT_RUN_STATUSES.has(run.status)) return cloneRun(run);
      run.status = "cancelled";
      run.finishedAt = new Date().toISOString();
      run.error = "Cancelled by user";
      return cloneRun(run);
    });
    if (!result) throw new AgentRunNotFoundError("Agent run not found");

    const active = this.active.get(runId);
    if (active?.session) {
      await active.session.send({ type: "abort" }).catch(() => {});
    }
    if (active) this.cleanup(runId);
    this.resolveWaiter(result);
    this.drain();
    return result;
  }

  private updateRun(runId: string, status: AgentRunStatus, patch: Partial<AgentRun> = {}): AgentRun | null {
    const updated = mutateAgentRunStore((store) => {
      const run = store.runs.find((item) => item.id === runId);
      if (!run || TERMINAL_AGENT_RUN_STATUSES.has(run.status)) return null;
      Object.assign(run, patch, { status });
      if (patch.budgetGroup) for (const member of store.runs) {
        if (member.budgetGroup?.id === patch.budgetGroup.id) member.budgetGroup = { ...patch.budgetGroup };
      }
      return cloneRun(run);
    });
    if (updated) this.waiters.get(runId)?.onUpdate?.(updated);
    return updated;
  }

  private groupCost(run: AgentRun): number {
    if (!run.budgetGroup) return 0;
    return readAgentRunStore().runs.filter(item => item.budgetGroup?.id === run.budgetGroup!.id)
      .reduce((sum, item) => sum + (item.progress?.costUsd ?? item.report?.usage.cost ?? 0), 0);
  }

  private stopExhaustedGroup(run: AgentRun): boolean {
    if (!run.budgetGroup || this.groupCost(run) < run.budgetGroup.maxCostUsd) return false;
    const error = `Delegation reached its shared $${run.budgetGroup.maxCostUsd} cost limit`;
    const stopped = mutateAgentRunStore(store => {
      const affected = store.runs.filter(item => item.budgetGroup?.id === run.budgetGroup!.id && !TERMINAL_AGENT_RUN_STATUSES.has(item.status));
      for (const item of affected) {
        item.status = "failed"; item.error = error; item.finishedAt = new Date().toISOString();
        const messages = this.active.get(item.id)?.messages;
        if (messages) item.report = buildAgentRunReport(messages, item.startedAt, item.finishedAt);
      }
      return affected.map(cloneRun);
    });
    for (const item of stopped) {
      const active = this.active.get(item.id);
      this.cleanup(item.id);
      void active?.session?.send({ type: "abort" }).catch(() => {});
      this.resolveWaiter(item, active?.messages);
    }
    return true;
  }

  private drain(): void {
    if (this.draining || this.maxConcurrency <= 0) return;
    this.draining = true;
    try {
      while (this.active.size < this.maxConcurrency) {
        const reserved = mutateAgentRunStore((store) => {
          const run = [...store.runs].reverse().find((item) => item.status === "queued");
          if (!run) return null;
          run.status = "running";
          run.startedAt = new Date().toISOString();
          return cloneRun(run);
        });
        if (!reserved) break;
        if (this.stopExhaustedGroup(reserved)) continue;
        this.active.set(reserved.id, {
          run: reserved,
          messages: [],
          session: null,
          unsubscribe: null,
          keepAlive: null,
          timeout: null,
          pendingDialogs: new Set(),
          turns: 0,
          costUsd: 0,
        });
        void this.execute(reserved);
      }
    } finally {
      this.draining = false;
    }
  }

  private finish(runId: string, status: "completed" | "failed", error?: string, messages?: AgentMessage[]): void {
    if (!this.active.has(runId)) return;
    const existing = readAgentRunStore().runs.find((run) => run.id === runId);
    const finishedAt = new Date().toISOString();
    const completed = this.updateRun(runId, status, {
      finishedAt,
      ...(error ? { error } : {}),
      ...(messages ? { report: buildAgentRunReport(messages, existing?.startedAt, finishedAt) } : {}),
    });
    this.cleanup(runId);
    if (completed) this.resolveWaiter(completed, messages);
    this.drain();
  }

  private resolveWaiter(run: AgentRun, messages?: AgentMessage[]): void {
    const waiter = this.waiters.get(run.id);
    if (!waiter) return;
    this.waiters.delete(run.id);
    waiter.removeAbortListener?.();
    waiter.resolve({ run: cloneRun(run), ...(messages ? { messages } : {}) });
  }

  private cleanup(runId: string): void {
    const active = this.active.get(runId);
    if (!active) return;
    active.unsubscribe?.();
    if (active.keepAlive) clearInterval(active.keepAlive);
    if (active.timeout) clearTimeout(active.timeout);
    this.active.delete(runId);
  }

  private async execute(run: AgentRun): Promise<void> {
    const active = this.active.get(run.id);
    if (!active) return;
    try {
      if (!await isTrustedAgentRunWorkspace(run.cwd)) {
        throw new Error("Workspace is no longer trusted; open it as a project before retrying");
      }
      const started = await startRpcSession(`__daemon__${run.id}`, "", run.cwd, run.toolNames, { toolMode: "custom" });
      if (!this.active.has(run.id)) {
        await started.session.send({ type: "abort" }).catch(() => {});
        return;
      }
      active.session = started.session;
      this.updateRun(run.id, "running", { sessionId: started.realSessionId });
      globalThis.__piAllowedRootsCache?.roots.add(run.cwd);

      active.unsubscribe = started.session.onEvent((rawEvent) => {
        const event = rawEvent as AgentEvent | WebExtensionUIEvent;
        if (isWebExtensionUIEvent(event)) {
          if (isWebExtensionUIDialogRequest(event)) {
            active.pendingDialogs.add(event.id);
            this.updateRun(run.id, "waiting_for_input");
            void import("./web-push").then(({ sendWebPush }) => sendWebPush(`/?session=${encodeURIComponent(started.realSessionId)}`)).catch(() => {});
          } else if (event.type === "extension_ui_closed") {
            active.pendingDialogs.delete(event.id);
            if (active.pendingDialogs.size === 0) this.updateRun(run.id, "running");
          }
          return;
        }
        if (event.type === "agent_end") {
          const error = eventRunError(event);
          if (error) void import("./web-push").then(({ sendWebPush }) => sendWebPush(`/?session=${encodeURIComponent(started.realSessionId)}`)).catch(() => {});
          this.finish(run.id, error ? "failed" : "completed", error ?? undefined, event.messages as AgentMessage[]);
          return;
        }
        if (event.type === "message_end") {
          const message = event.message as AgentMessage | undefined;
          if (message) active.messages.push(message);
          if (message?.role !== "assistant") return;
          active.turns += 1;
          active.costUsd += message.usage?.cost.total ?? 0;
          this.publishProgress(active);
          if (this.stopExhaustedGroup(run)) { this.drain(); return; }
          const turnsExceeded = !!run.limits?.maxTurns && active.turns > run.limits.maxTurns;
          const costExceeded = !!run.limits?.maxCostUsd && active.costUsd > run.limits.maxCostUsd;
          if (!turnsExceeded && !costExceeded) return;
          const reason = turnsExceeded
            ? `Subagent exceeded the ${run.limits?.maxTurns}-turn limit`
            : `Subagent exceeded the $${run.limits?.maxCostUsd?.toFixed(2)} cost limit`;
          void started.session.send({ type: "abort" }).catch(() => {});
          this.finish(run.id, "failed", reason, active.messages);
        }
      });

      if (run.provider && run.modelId) {
        await started.session.send({
          type: "set_model",
          provider: run.provider,
          modelId: run.modelId,
        });
      }
      if (run.thinkingLevel) {
        await started.session.send({ type: "set_thinking_level", level: run.thinkingLevel });
      }

      active.keepAlive = setInterval(() => {
        this.publishProgress(active);
        if (!started.session.isAlive()) {
          this.finish(run.id, "failed", "The agent session closed before the run completed");
          return;
        }
        void started.session.send({ type: "get_state" })
          .catch((error) => this.finish(run.id, "failed", String(error)));
      }, KEEP_ALIVE_MS);
      active.keepAlive.unref?.();

      this.armDeadline(active);

      await started.session.send({
        type: "prompt",
        message: run.prompt,
        awaitCompletion: true,
      });
      this.finish(run.id, "completed");
    } catch (error) {
      this.finish(run.id, "failed", error instanceof Error ? error.message : String(error));
    }
  }
}

declare global {
  var __piAgentRunSupervisor: AgentRunSupervisor | undefined;
}

export function ensureAgentRunSupervisor(): AgentRunSupervisor {
  if (!globalThis.__piAgentRunSupervisor) {
    globalThis.__piAgentRunSupervisor = new AgentRunSupervisor();
    globalThis.__piAgentRunSupervisor.start();
  }
  return globalThis.__piAgentRunSupervisor;
}
