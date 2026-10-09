import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startRpcSession, type AgentEvent, type AgentSessionWrapper } from "./rpc-manager";
import { nextScheduleRunAt } from "./schedule-core";
import { mutateScheduleStore, readScheduleStore, reconcileInterruptedRuns } from "./schedule-store";
import { ACTIVE_SCHEDULE_RUN_STATUSES, type AgentSchedule, type ScheduleRun, type ScheduleRunStatus, type SchedulerHealth } from "./schedule-types";
import type { WebExtensionUIEvent } from "./web-extension-ui";
import { isWebExtensionUIDialogRequest, isWebExtensionUIEvent } from "./web-extension-ui-types";
import { durableSessionDirectory, durableSessionId } from "./durable-session-store";

const MISSED_GRACE_MS = 60_000;
const KEEP_ALIVE_MS = 4 * 60_000;
const MAX_RUN_MS = 24 * 60 * 60_000;
const MAX_TIMER_MS = 24 * 60 * 60_000;

export class ScheduleConflictError extends Error {}
export class ScheduleNotFoundError extends Error {}

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

function nextAfterExecution(schedule: AgentSchedule, after: Date): string | null {
  if (schedule.timing.kind === "once") return null;
  return nextScheduleRunAt(schedule.timing, schedule.timezone, after);
}

function addRun(store: ReturnType<typeof readScheduleStore>, run: ScheduleRun): void {
  store.runs.unshift(run);
}

export class ScheduleRunner {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ticking = false;
  private started = false;
  private readonly startedAt = new Date().toISOString();
  private lastHeartbeatAt = this.startedAt;
  private lastTickAt: string | null = null;
  private nextWakeAt: string | null = null;
  private tickCount = 0;
  private missedRuns = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly durableExecutions = new Map<string, () => void>();

  start(): void {
    if (this.started) return;
    this.started = true;
    reconcileInterruptedRuns();
    for (const run of readScheduleStore().runs) {
      if (run.engine === "durable" && ACTIVE_SCHEDULE_RUN_STATUSES.has(run.status)) {
        void this.executeDurable(structuredClone(run));
      }
    }
    this.heartbeat = setInterval(() => { this.lastHeartbeatAt = new Date().toISOString(); }, 30_000);
    this.heartbeat.unref?.();
    this.reschedule();
  }

  dispose(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.timer = null;
    this.heartbeat = null;
    this.nextWakeAt = null;
    for (const detach of this.durableExecutions.values()) detach();
  }

  getHealth(): SchedulerHealth {
    return {
      state: this.nextWakeAt ? "healthy" : "idle",
      startedAt: this.startedAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastTickAt: this.lastTickAt,
      nextWakeAt: this.nextWakeAt,
      tickCount: this.tickCount,
      missedRuns: this.missedRuns,
    };
  }

  async wake(now = new Date()): Promise<SchedulerHealth> {
    await this.tick(now);
    return this.getHealth();
  }

  reschedule(): void {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextWakeAt = null;
    const next = readScheduleStore().schedules
      .filter((schedule) => schedule.enabled && schedule.nextRunAt)
      .map((schedule) => Date.parse(schedule.nextRunAt as string))
      .filter(Number.isFinite)
      .sort((a, b) => a - b)[0];
    if (next === undefined) return;
    this.nextWakeAt = new Date(next).toISOString();
    const delay = Math.max(25, Math.min(MAX_TIMER_MS, next - Date.now()));
    this.timer = setTimeout(() => void this.tick(), delay);
    this.timer.unref?.();
  }

  async tick(now = new Date()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    this.lastHeartbeatAt = now.toISOString();
    this.lastTickAt = now.toISOString();
    this.tickCount += 1;
    try {
      const due = readScheduleStore().schedules.filter((schedule) =>
        schedule.enabled && schedule.nextRunAt !== null
        && Date.parse(schedule.nextRunAt) <= now.getTime(),
      );
      for (const schedule of due) {
        const scheduledFor = schedule.nextRunAt as string;
        const missed = now.getTime() - Date.parse(scheduledFor) > MISSED_GRACE_MS;
        if (missed && schedule.missedRunPolicy === "skip") {
          this.missedRuns += 1;
          this.skipRun(schedule.id, scheduledFor, "Missed while the server was unavailable", now);
          continue;
        }
        try {
          this.startRun(schedule.id, "scheduled", scheduledFor, now);
        } catch (error) {
          if (error instanceof ScheduleConflictError) {
            this.skipRun(schedule.id, scheduledFor, "Previous run is still active", now);
          } else if (!(error instanceof ScheduleNotFoundError)) {
            console.error("Failed to start scheduled agent", error);
          }
        }
      }
    } finally {
      this.ticking = false;
      this.reschedule();
    }
  }

  runNow(scheduleId: string): ScheduleRun {
    return this.startRun(scheduleId, "manual", new Date().toISOString(), new Date());
  }

  private skipRun(scheduleId: string, scheduledFor: string, reason: string, now: Date): void {
    mutateScheduleStore((store) => {
      const schedule = store.schedules.find((item) => item.id === scheduleId);
      if (!schedule || schedule.nextRunAt !== scheduledFor) return;
      schedule.nextRunAt = nextAfterExecution(schedule, now);
      if (schedule.timing.kind === "once") schedule.enabled = false;
      schedule.updatedAt = now.toISOString();
      schedule.lastRunAt = now.toISOString();
      schedule.lastRunStatus = "skipped";
      addRun(store, {
        id: randomUUID(),
        scheduleId,
        scheduleName: schedule.name,
        trigger: "scheduled",
        scheduledFor,
        startedAt: now.toISOString(),
        finishedAt: now.toISOString(),
        status: "skipped",
        error: reason,
      });
    });
  }

  private startRun(
    scheduleId: string,
    trigger: ScheduleRun["trigger"],
    scheduledFor: string,
    now: Date,
  ): ScheduleRun {
    const reserved = mutateScheduleStore((store) => {
      const schedule = store.schedules.find((item) => item.id === scheduleId);
      if (!schedule) throw new ScheduleNotFoundError("Schedule not found");
      if (trigger === "scheduled" && (!schedule.enabled || schedule.nextRunAt !== scheduledFor)) {
        throw new ScheduleConflictError("Schedule is no longer due");
      }
      if (store.runs.some((run) => run.scheduleId === scheduleId && ACTIVE_SCHEDULE_RUN_STATUSES.has(run.status))) {
        throw new ScheduleConflictError("This schedule already has an active run");
      }

      const run: ScheduleRun = {
        id: randomUUID(),
        scheduleId,
        scheduleName: schedule.name,
        trigger,
        scheduledFor,
        startedAt: now.toISOString(),
        status: "running",
      };
      if (schedule.engine === "durable") {
        run.engine = "durable";
        run.sessionId = durableSessionId(run.id, 1);
        run.execution = {
          cwd: schedule.cwd, prompt: schedule.prompt, provider: schedule.provider,
          modelId: schedule.modelId, thinkingLevel: schedule.thinkingLevel,
          toolNames: [...schedule.toolNames],
        };
      }
      schedule.lastRunAt = now.toISOString();
      schedule.lastRunStatus = "running";
      schedule.updatedAt = now.toISOString();
      if (trigger === "scheduled") {
        schedule.nextRunAt = nextAfterExecution(schedule, now);
        if (schedule.timing.kind === "once") schedule.enabled = false;
      }
      addRun(store, run);
      return { run: { ...run }, schedule: structuredClone(schedule) };
    });
    this.reschedule();
    if (reserved.run.engine === "durable") void this.executeDurable(structuredClone(reserved.run));
    else void this.execute(reserved.schedule, reserved.run.id);
    return reserved.run;
  }

  private updateRun(runId: string, status: ScheduleRunStatus, patch: Partial<ScheduleRun> = {}): void {
    mutateScheduleStore((store) => {
      const run = store.runs.find((item) => item.id === runId);
      if (!run) return;
      Object.assign(run, patch, { status });
      const schedule = store.schedules.find((item) => item.id === run.scheduleId);
      if (schedule) schedule.lastRunStatus = status;
    });
  }

  private async executeDurable(run: ScheduleRun): Promise<void> {
    if (this.durableExecutions.has(run.id)) return;
    let session: Awaited<ReturnType<typeof import("./durable-chat")["openDurableChat"]>> | undefined;
    let unsubscribe: (() => void) | undefined;
    let keepAlive: ReturnType<typeof setInterval> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let detached = false;
    const pendingDialogs = new Set<string>();
    const detach = () => {
      detached = true;
      unsubscribe?.();
      if (keepAlive) clearInterval(keepAlive);
      if (timeout) clearTimeout(timeout);
      this.durableExecutions.delete(run.id);
    };
    this.durableExecutions.set(run.id, detach);
    const finish = (status: "completed" | "failed", error?: string) => {
      if (detached) return;
      detach();
      this.updateRun(run.id, status, { finishedAt: new Date().toISOString(), ...(error ? { error } : {}) });
    };
    const notify = () => {
      void import("./web-push").then(({ sendWebPush }) => sendWebPush(`/?session=${encodeURIComponent(run.sessionId!)}`)).catch(() => {});
    };
    const expire = () => {
      void session?.send({ type: "abort" }).catch(() => {});
      finish("failed", "Scheduled run exceeded the 24-hour limit");
    };
    try {
      if (!run.execution || run.sessionId !== durableSessionId(run.id, 1)) {
        throw new Error("The durable schedule is missing its original execution settings");
      }
      const execution = run.execution;
      const deadline = Date.parse(run.startedAt) + MAX_RUN_MS;
      if (!Number.isFinite(deadline)) throw new Error("Invalid scheduled run start time");
      const { createDurableChat, getDurableChat, openDurableChat } = await import("./durable-chat");
      if (detached) return;
      const existing = getDurableChat(run.sessionId);
      const hasStore = existsSync(join(durableSessionDirectory(run.id), "bootstrap.json"));
      if (Date.now() >= deadline && !existing && !hasStore) { expire(); return; }
      session = existing ?? (hasStore
        ? await openDurableChat(run.sessionId)
        : await createDurableChat({ ...execution, group: run.id, scheduleDeadline: deadline }));
      if (detached) return;
      if (Date.now() >= deadline) { expire(); return; }
      globalThis.__piAllowedRootsCache?.roots.add(execution.cwd);
      unsubscribe = session.onEvent((rawEvent) => {
        if (detached) return;
        if (rawEvent.type === "session_restart") { detach(); return; }
        const event = rawEvent as AgentEvent | WebExtensionUIEvent;
        if (!isWebExtensionUIEvent(event)) return;
        if (isWebExtensionUIDialogRequest(event)) {
          pendingDialogs.add(event.id);
          this.updateRun(run.id, "waiting_for_input");
          notify();
        } else if (event.type === "extension_ui_closed") {
          pendingDialogs.delete(event.id);
          if (pendingDialogs.size === 0) this.updateRun(run.id, "running");
        }
      });
      // A recovered dialog is replayed by onEvent before this update.
      if (pendingDialogs.size === 0) this.updateRun(run.id, "running");
      keepAlive = setInterval(() => {
        if (!session?.isAlive()) { detach(); return; }
        void session.send({ type: "get_state" }).catch(() => {
          // A host restart is recoverable; the next runner attaches to this receipt.
          if (!session?.isAlive()) detach();
        });
      }, KEEP_ALIVE_MS);
      keepAlive.unref?.();
      timeout = setTimeout(expire, Math.max(1, deadline - Date.now()));
      timeout.unref?.();
      await session.send({ type: "prompt", message: execution.prompt,
        requestId: `schedule:${run.id}`, awaitCompletion: true });
      // agent_end is not a durable commit barrier. Only settlement confirms completion.
      finish("completed");
    } catch (error) {
      if (detached) return;
      if (session && !session.isAlive()) { detach(); return; }
      notify();
      finish("failed", error instanceof Error ? error.message : String(error));
    }
  }

  private async execute(schedule: AgentSchedule, runId: string): Promise<void> {
    let session: AgentSessionWrapper | null = null;
    let unsubscribe: (() => void) | null = null;
    let keepAlive: ReturnType<typeof setInterval> | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let finished = false;
    const pendingDialogs = new Set<string>();

    const cleanup = () => {
      unsubscribe?.();
      unsubscribe = null;
      if (keepAlive) clearInterval(keepAlive);
      if (timeout) clearTimeout(timeout);
      keepAlive = null;
      timeout = null;
    };
    const finish = (status: "completed" | "failed", error?: string) => {
      if (finished) return;
      finished = true;
      cleanup();
      this.updateRun(runId, status, {
        finishedAt: new Date().toISOString(),
        ...(error ? { error } : {}),
      });
    };

    try {
      const started = await startRpcSession(`__schedule__${runId}`, "", schedule.cwd, schedule.toolNames);
      session = started.session;
      this.updateRun(runId, "running", { sessionId: started.realSessionId });
      globalThis.__piAllowedRootsCache?.roots.add(schedule.cwd);

      unsubscribe = session.onEvent((rawEvent) => {
        const event = rawEvent as AgentEvent | WebExtensionUIEvent;
        if (isWebExtensionUIEvent(event)) {
          if (isWebExtensionUIDialogRequest(event)) {
            pendingDialogs.add(event.id);
            this.updateRun(runId, "waiting_for_input");
            void import("./web-push").then(({ sendWebPush }) => sendWebPush(`/?session=${encodeURIComponent(started.realSessionId)}`)).catch(() => {});
          } else if (event.type === "extension_ui_closed") {
            pendingDialogs.delete(event.id);
            if (pendingDialogs.size === 0) this.updateRun(runId, "running");
          }
          return;
        }
        if (event.type === "agent_end") {
          const error = eventRunError(event);
          if (error) void import("./web-push").then(({ sendWebPush }) => sendWebPush(`/?session=${encodeURIComponent(started.realSessionId)}`)).catch(() => {});
          finish(error ? "failed" : "completed", error ?? undefined);
        }
      });

      if (schedule.provider && schedule.modelId) {
        await session.send({ type: "set_model", provider: schedule.provider, modelId: schedule.modelId });
      }
      if (schedule.thinkingLevel) {
        await session.send({ type: "set_thinking_level", level: schedule.thinkingLevel });
      }

      keepAlive = setInterval(() => {
        if (!session?.isAlive()) {
          finish("failed", "The agent session closed before the run completed");
          return;
        }
        void session.send({ type: "get_state" }).catch((error) => finish("failed", String(error)));
      }, KEEP_ALIVE_MS);
      keepAlive.unref?.();
      timeout = setTimeout(() => {
        void session?.send({ type: "abort" }).catch(() => {});
        finish("failed", "Scheduled run exceeded the 24-hour limit");
      }, MAX_RUN_MS);
      timeout.unref?.();

      await session.send({ type: "prompt", message: schedule.prompt, awaitCompletion: true });
    } catch (error) {
      finish("failed", error instanceof Error ? error.message : String(error));
    }
  }
}

declare global {
  var __piScheduleRunner: ScheduleRunner | undefined;
}

export function ensureScheduleRunner(): ScheduleRunner {
  if (!globalThis.__piScheduleRunner) {
    globalThis.__piScheduleRunner = new ScheduleRunner();
    globalThis.__piScheduleRunner.start();
  }
  return globalThis.__piScheduleRunner;
}
