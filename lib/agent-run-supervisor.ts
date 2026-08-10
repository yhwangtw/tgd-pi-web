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
  type AgentRunInput,
  type AgentRunStatus,
} from "./agent-run-types";
import type { WebExtensionUIEvent } from "./web-extension-ui";
import { isWebExtensionUIDialogRequest, isWebExtensionUIEvent } from "./web-extension-ui-types";
import { isTrustedAgentRunWorkspace } from "./agent-run-workspace";
import { buildAgentRunReport } from "./agent-run-report";
import type { AgentMessage } from "./types";

const KEEP_ALIVE_MS = 4 * 60_000;
const MAX_RUN_MS = 24 * 60 * 60_000;

interface ActiveRun {
  session: AgentSessionWrapper | null;
  unsubscribe: (() => void) | null;
  keepAlive: ReturnType<typeof setInterval> | null;
  timeout: ReturnType<typeof setTimeout> | null;
  pendingDialogs: Set<string>;
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

  enqueue(input: AgentRunInput, options: {
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
      store.runs.unshift(run);
    });
    this.drain();
    return cloneRun(run);
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
    this.drain();
    return result;
  }

  private updateRun(runId: string, status: AgentRunStatus, patch: Partial<AgentRun> = {}): void {
    mutateAgentRunStore((store) => {
      const run = store.runs.find((item) => item.id === runId);
      if (!run || TERMINAL_AGENT_RUN_STATUSES.has(run.status)) return;
      Object.assign(run, patch, { status });
    });
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
        this.active.set(reserved.id, {
          session: null,
          unsubscribe: null,
          keepAlive: null,
          timeout: null,
          pendingDialogs: new Set(),
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
    this.updateRun(runId, status, {
      finishedAt,
      ...(error ? { error } : {}),
      ...(messages ? { report: buildAgentRunReport(messages, existing?.startedAt, finishedAt) } : {}),
    });
    this.cleanup(runId);
    this.drain();
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
      const started = await startRpcSession(`__daemon__${run.id}`, "", run.cwd, run.toolNames);
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
        if (!started.session.isAlive()) {
          this.finish(run.id, "failed", "The agent session closed before the run completed");
          return;
        }
        void started.session.send({ type: "get_state" })
          .catch((error) => this.finish(run.id, "failed", String(error)));
      }, KEEP_ALIVE_MS);
      active.keepAlive.unref?.();

      active.timeout = setTimeout(() => {
        void started.session.send({ type: "abort" }).catch(() => {});
        this.finish(run.id, "failed", "Agent run exceeded the 24-hour limit");
      }, MAX_RUN_MS);
      active.timeout.unref?.();

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
